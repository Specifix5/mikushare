import { Elysia } from 'elysia';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { mkdtemp, open, rm, readdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { db, getUserFromKey } from '../db/client';
import { getAccessKey } from '../core/helpers';
import {
  MAX_BATCH_FILE_SIZE,
  MAX_FILE_SIZE,
  MAX_TEMP_FILE_SIZE,
  MAX_TEXT_SIZE,
  MAX_UPLOAD_FILES,
} from '../config/constants';
import { byteLimit, requestStream, UploadError } from './stream';
import { storeUploads } from './routes';
import { uniqueFilenames } from '../files/filenames';
import { textTitleSchema } from '../texts/content';

export const CHUNK_SIZE = 4 * 1024 * 1024;
const CHUNK_CONCURRENCY = 4;
const SESSION_TTL = 30 * 60 * 1000;
const manifestSchema = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(150),
        size: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(MAX_UPLOAD_FILES),
  ttl: z.number().min(1).max(168).optional(),
  collectionName: z.string().max(150).optional(),
  textTitle: textTitleSchema.optional(),
});
type Manifest = z.infer<typeof manifestSchema>;
interface Session {
  ownerId: number;
  directory: string;
  manifest: Manifest;
  expires: number;
  received: Set<string>;
  writing: Set<string>;
  completing: boolean;
}
const sessions = new Map<string, Session>();
const starting = new Map<number, number>();
async function discard(id: string, session: Session) {
  sessions.delete(id);
  await rm(session.directory, { recursive: true, force: true });
}
async function sweep() {
  for (const [id, session] of sessions)
    if (
      session.expires <= Date.now() &&
      !session.writing.size &&
      !session.completing
    )
      await discard(id, session);
  // In-memory sessions expire across restarts. Remove their old staging data.
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('miku-chunks-'))
      continue;
    const directory = path.join(tmpdir(), entry.name);
    if (
      [...sessions.values()].some((session) => session.directory === directory)
    )
      continue;
    if ((await stat(directory)).mtimeMs < Date.now() - SESSION_TTL)
      await rm(directory, { recursive: true, force: true });
  }
}
const sweepTimer = setInterval(() => {
  void sweep().catch((error: unknown) => {
    console.error('Upload staging cleanup failed', error);
  });
}, 60_000);
sweepTimer.unref();
async function authorize(request: Request) {
  const token = getAccessKey(request);
  return token ? getUserFromKey(db, token) : null;
}
async function access(request: Request, id: string) {
  const user = await authorize(request);
  const session = sessions.get(id);
  if (!user) throw new UploadError('Unauthorized', 401);
  if (session?.ownerId !== user.id) {
    throw new UploadError('Upload session not found', 404);
  }
  if (session.expires <= Date.now())
    throw new UploadError('Upload session expired; select files again', 410);
  return session;
}
function guarded<T extends { request: Request }>(
  handler: (context: T) => Promise<Response>,
) {
  return async (context: T) => {
    try {
      return await handler(context);
    } catch (error) {
      if (context.request.body && !context.request.body.locked)
        await context.request.body.cancel().catch(() => undefined);
      return new Response(
        error instanceof UploadError ? error.message : 'Upload failed',
        { status: error instanceof UploadError ? error.status : 500 },
      );
    }
  };
}
export const chunkRoutes = () =>
  new Elysia({ prefix: '/ui-upload' })
    .post(
      '',
      guarded(async ({ request }: { request: Request }) => {
        const user = await authorize(request);
        if (!user) throw new UploadError('Unauthorized', 401);
        await sweep();
        if (
          sessions.size +
            [...starting.values()].reduce((sum, count) => sum + count, 0) >=
            32 ||
          [...sessions.values()].filter(
            (session) => session.ownerId === user.id,
          ).length +
            (starting.get(user.id) ?? 0) >=
            4
        )
          throw new UploadError(
            'Too many active uploads; try again later',
            429,
          );
        starting.set(user.id, (starting.get(user.id) ?? 0) + 1);
        try {
          const buffers: Buffer[] = [];
          await pipeline(
            requestStream(request),
            byteLimit(16 * 1024, 'Upload manifest too large'),
            new Writable({
              write(chunk: Buffer, _encoding, callback) {
                buffers.push(chunk);
                callback();
              },
            }),
          );
          let value: unknown;
          try {
            value = JSON.parse(Buffer.concat(buffers).toString());
          } catch {
            throw new UploadError('Invalid upload manifest');
          }
          const parsed = manifestSchema.safeParse(value);
          if (!parsed.success) throw new UploadError('Invalid upload manifest');
          const manifest = parsed.data;
          if (manifest.textTitle !== undefined) {
            if (
              manifest.files.length !== 1 ||
              !/\.txt$/i.test(manifest.files[0]!.name) ||
              manifest.collectionName !== undefined
            )
              throw new UploadError(
                'Text pastes require one .txt file and no collection',
              );
            if (manifest.files[0]!.size > MAX_TEXT_SIZE * 1024 * 1024)
              throw new UploadError(
                `Max text size is ${MAX_TEXT_SIZE} MB`,
                413,
              );
          }
          const limit = manifest.ttl ? MAX_TEMP_FILE_SIZE : MAX_FILE_SIZE;
          if (manifest.files.some((file) => file.size > limit * 1024 * 1024))
            throw new UploadError(`Max per file is ${limit} MB`, 413);
          if (
            manifest.files.reduce((sum, file) => sum + file.size, 0) >
            MAX_BATCH_FILE_SIZE * 1024 * 1024
          )
            throw new UploadError(
              `Max total is ${MAX_BATCH_FILE_SIZE} MB`,
              413,
            );
          const names = uniqueFilenames(
            manifest.files.map((file) => file.name),
          );
          manifest.files.forEach((file, index) => {
            file.name = names[index]!;
          });
          const id = randomBytes(24).toString('base64url');
          const directory = await mkdtemp(path.join(tmpdir(), 'miku-chunks-'));
          const session: Session = {
            ownerId: user.id,
            directory,
            manifest,
            expires: Date.now() + SESSION_TTL,
            received: new Set(),
            writing: new Set(),
            completing: false,
          };
          // Create empty files too; each chunk later opens an existing file without truncating.
          try {
            for (let index = 0; index < manifest.files.length; index++) {
              const handle = await open(
                path.join(directory, String(index)),
                'wx',
              );
              await handle.close();
            }
          } catch (error) {
            await discard(id, session);
            throw error;
          }
          // Publish only after staging files exist. No await separates this from
          // releasing the starting reservation in finally, avoiding double counts.
          sessions.set(id, session);
          return Response.json(
            {
              id,
              chunkSize: CHUNK_SIZE,
              concurrency: CHUNK_CONCURRENCY,
              expiresAt: session.expires,
            },
            { status: 201, headers: { 'Cache-Control': 'no-store' } },
          );
        } finally {
          const count = (starting.get(user.id) ?? 1) - 1;
          if (count) starting.set(user.id, count);
          else starting.delete(user.id);
        }
      }),
      { parse: 'none' },
    )
    .put(
      '/:id/:file/:chunk',
      guarded(
        async ({
          request,
          params,
        }: {
          request: Request;
          params: { id: string; file: string; chunk: string };
        }) => {
          const session = await access(request, params.id);
          if (session.completing)
            throw new UploadError('Upload is completing', 409);
          if (!/^\d+$/.test(params.file) || !/^\d+$/.test(params.chunk))
            throw new UploadError('Invalid chunk');
          const index = Number(params.file),
            chunk = Number(params.chunk);
          const file = session.manifest.files[index];
          if (
            !file ||
            !Number.isSafeInteger(chunk) ||
            chunk >= Math.ceil(file.size / CHUNK_SIZE)
          )
            throw new UploadError('Invalid chunk');
          const key = `${index}:${chunk}`;
          if (session.writing.has(key))
            throw new UploadError('Chunk is already uploading', 409);
          if (session.writing.size >= CHUNK_CONCURRENCY)
            throw new UploadError('Too many concurrent chunks', 429);
          const expected = Math.min(CHUNK_SIZE, file.size - chunk * CHUNK_SIZE);
          const length = request.headers.get('content-length');
          if (length !== null && Number(length) !== expected)
            throw new UploadError(
              'Chunk size does not match manifest',
              Number(length) > expected ? 413 : 400,
            );
          session.writing.add(key);
          session.received.delete(key);
          session.expires = Date.now() + SESSION_TTL;
          let offset = chunk * CHUNK_SIZE;
          try {
            const handle = await open(
              path.join(session.directory, String(index)),
              'r+',
            );
            try {
              await pipeline(
                requestStream(request),
                byteLimit(expected, 'Chunk size exceeds limit', expected),
                new Writable({
                  write(bytes: Buffer, _encoding, callback) {
                    void (async () => {
                      let written = 0;
                      while (written < bytes.length) {
                        const result = await handle.write(
                          bytes,
                          written,
                          bytes.length - written,
                          offset,
                        );
                        if (!result.bytesWritten)
                          throw new Error('No write progress');
                        written += result.bytesWritten;
                        offset += result.bytesWritten;
                      }
                    })().then(
                      () => callback(),
                      (error: Error) => callback(error),
                    );
                  },
                }),
              );
            } finally {
              await handle.close();
            }
            session.received.add(key);
            return new Response(null, { status: 204 });
          } finally {
            session.writing.delete(key);
            session.expires = Date.now() + SESSION_TTL;
          }
        },
      ),
      { parse: 'none' },
    )
    .post(
      '/:id/complete',
      guarded(
        async ({
          request,
          params,
        }: {
          request: Request;
          params: { id: string };
        }) => {
          const session = await access(request, params.id);
          if (session.completing || session.writing.size)
            throw new UploadError('Chunks are still uploading', 409);
          for (const [index, file] of session.manifest.files.entries())
            for (
              let chunk = 0;
              chunk < Math.ceil(file.size / CHUNK_SIZE);
              chunk++
            )
              if (!session.received.has(`${index}:${chunk}`))
                throw new UploadError('Missing upload chunks', 409);
          session.completing = true;
          try {
            const uploads = session.manifest.files.map((file, index) => ({
              name: file.name,
              blob: Bun.file(path.join(session.directory, String(index))),
            }));
            if (
              uploads.some(
                (file, index) =>
                  file.blob.size !== session.manifest.files[index]?.size,
              )
            )
              throw new UploadError('File size does not match manifest');
            return await storeUploads(
              getAccessKey(request)!,
              uploads,
              session.manifest.ttl,
              session.manifest.collectionName,
              session.manifest.textTitle,
            );
          } finally {
            await discard(params.id, session);
          }
        },
      ),
      { parse: 'none' },
    )
    .delete(
      '/:id',
      guarded(
        async ({
          request,
          params,
        }: {
          request: Request;
          params: { id: string };
        }) => {
          const session = await access(request, params.id);
          if (session.completing || session.writing.size)
            throw new UploadError('Upload is busy', 409);
          await discard(params.id, session);
          return new Response(null, { status: 204 });
        },
      ),
      { parse: 'none' },
    );
