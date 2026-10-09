import path from 'path';
import { unlink } from 'fs/promises';
import {
  BASE_URL,
  MAX_BATCH_FILE_SIZE,
  MAX_FILE_SIZE,
  MAX_TEMP_FILE_SIZE,
  UPLOADS_DIR,
} from './utils/constants';
import { db, addFile, getUserFromKey, withTransaction } from './db/client';
import { getAccessKey } from './utils/helpers';
import { hashFile } from './utils/hashing';
import { error, info } from './cli';
import { uniqueFilenames, normalizeFilename } from './utils/filenames';
import { addCollection } from './utils/collections';
import {
  lockFileStorage,
  withStorageQueue,
  writeDeduplicated,
} from './utils/dedup';
import { parseUpload, UploadError } from './utils/upload-stream';

const MAX_LEGACY_UPLOADS = 16;
const MAX_LEGACY_UPLOADS_PER_ACCOUNT = 4;
let activeLegacyUploads = 0;
const accountUploads = new Map<number, number>();

export const storeUploads = async (
  accessKey: string,
  uploads: { name: string; blob: Blob }[],
  ttl?: number,
  collectionName?: string,
) =>
  withStorageQueue(async () => {
    const names = uniqueFilenames(uploads.map((file) => file.name));
    const limit = ttl ? MAX_TEMP_FILE_SIZE : MAX_FILE_SIZE;
    if (uploads.some((file) => file.blob.size > limit * 1024 * 1024))
      return new Response(`Max per file is ${limit} MB`, { status: 413 });
    if (
      uploads.reduce((sum, file) => sum + file.blob.size, 0) >
      MAX_BATCH_FILE_SIZE * 1024 * 1024
    )
      return new Response(`Max total is ${MAX_BATCH_FILE_SIZE} MB`, {
        status: 413,
      });
    const written: string[] = [];
    try {
      const results = await withTransaction(async (tx) => {
        const user = await getUserFromKey(tx, accessKey);
        if (!user) return null;
        await lockFileStorage(tx);
        const results = [];
        for (const [index, file] of uploads.entries()) {
          const sha256 = await hashFile(file.blob);
          const name = names[index] ?? normalizeFilename(file.name);
          const extension = /\.[a-z0-9]{1,16}$/i.exec(name)?.[0] ?? '';
          const metadata = await addFile(
            tx,
            user.id,
            name,
            extension,
            file.blob.size,
            ttl ? new Date(Date.now() + ttl * 60 * 60 * 1000) : undefined,
            sha256,
          );
          const filepath = path.join(
            UPLOADS_DIR,
            ttl ? 'temp' : '',
            metadata.filename,
          );
          written.push(filepath);
          await writeDeduplicated(tx, filepath, file.blob, sha256);
          info(
            'Uploads',
            `${user.user} uploaded ${metadata.key} (${file.blob.size} bytes)`,
          );
          results.push({
            key: metadata.key,
            url: `${BASE_URL}/${metadata.key}`,
            filename: metadata.filename,
            realFilename: name,
            sha256,
            isTemp: !!ttl,
          });
        }
        const collection =
          collectionName !== undefined
            ? await addCollection(
                tx,
                user.id,
                results.map((file) => file.key),
                collectionName || 'collection',
              )
            : null;
        return { files: results, collection };
      });
      if (!results) return new Response('Unauthorized', { status: 401 });
      // Retain the original response fields for single-file API clients.
      return Response.json({ ...results.files[0], ...results });
    } catch {
      await Promise.allSettled(written.map((filepath) => unlink(filepath)));
      error(
        'Uploads',
        'Upload failed; rolled back metadata and removed new files',
      );
      return new Response('Upload failed. Please try again.', { status: 500 });
    }
  });

export const UploadHandler = async ({ request }: { request: Request }) => {
  const accessKey = getAccessKey(request);
  const user = accessKey ? await getUserFromKey(db, accessKey) : null;
  if (!accessKey || !user) {
    await request.body?.cancel().catch(() => undefined);
    return new Response('Unauthorized', {
      status: 401,
      headers: { Connection: 'close' },
    });
  }
  if (
    activeLegacyUploads >= MAX_LEGACY_UPLOADS ||
    (accountUploads.get(user.id) ?? 0) >= MAX_LEGACY_UPLOADS_PER_ACCOUNT
  ) {
    await request.body?.cancel().catch(() => undefined);
    return new Response('Too many active uploads; try again shortly.', {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        Connection: 'close',
        'Retry-After': '5',
      },
    });
  }
  // Hold the reservation through parsing, publishing, and staging cleanup.
  activeLegacyUploads++;
  accountUploads.set(user.id, (accountUploads.get(user.id) ?? 0) + 1);
  try {
    const parsed = await parseUpload(request);
    try {
      return await storeUploads(
        accessKey,
        parsed.uploads,
        parsed.ttl,
        parsed.collectionName,
      );
    } finally {
      await parsed.cleanup();
    }
  } catch (error) {
    if (request.body && !request.body.locked)
      await request.body.cancel().catch(() => undefined);
    if (error instanceof UploadError)
      return new Response(error.message, {
        status: error.status,
        headers: { Connection: 'close' },
      });
    return new Response('Upload failed. Please try again.', {
      status: 500,
      headers: { Connection: 'close' },
    });
  } finally {
    activeLegacyUploads--;
    const remaining = (accountUploads.get(user.id) ?? 1) - 1;
    if (remaining) accountUploads.set(user.id, remaining);
    else accountUploads.delete(user.id);
  }
};
