import { Elysia } from 'elysia';
import path from 'path';
import { db, getFile } from '../db/client';
import {
  BASE_URL,
  FILES_URL,
  MAX_BATCH_FILE_SIZE,
  MAX_FILE_SIZE,
  MAX_TEMP_FILE_SIZE,
  UPLOADS_DIR,
} from '../config/constants';
import { isStoredFile } from '../files/storage';
import { withEmbedMetadata } from '../sharing/embeds';
import { readTextContent } from './content';
import { UploadError } from '../uploads/stream';

const noCache = {
  'Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
};
const notFound = () =>
  new Response('Text not found', { status: 404, headers: noCache });

const readText = async (key: string) => {
  const file = await getFile(db, key);
  if (!file?.pasteTitle || (file.expiresAt && file.expiresAt <= new Date()))
    return null;
  const filepath = path.join(
    UPLOADS_DIR,
    file.expiresAt ? 'temp' : '',
    file.filename,
  );
  if (!(await isStoredFile(filepath))) return null;
  try {
    const blob = Bun.file(filepath);
    const limit = Math.min(
      file.expiresAt ? MAX_TEMP_FILE_SIZE : MAX_FILE_SIZE,
      MAX_BATCH_FILE_SIZE,
    );
    if (blob.size > limit * 1024 * 1024 || blob.size !== file.size) return null;
    const content = await readTextContent(blob);
    return { file, content };
  } catch (failure) {
    if (
      failure instanceof UploadError ||
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
        (failure as NodeJS.ErrnoException).code ?? '',
      )
    )
      return null;
    throw failure;
  }
};

export const textRoutes = () =>
  new Elysia({ prefix: '/texts' })
    .get('/:key', async ({ params }) => {
      const result = await readText(params.key);
      if (!result) return notFound();
      const { file } = result;
      const html = withEmbedMetadata(
        await Bun.file('dist/pages/text.html').text(),
        {
          title: file.pasteTitle!,
          description: `Text paste · ${file.size} bytes · Uploaded ${file.createdAt.toISOString()}`,
          url: `${BASE_URL}/texts/${file.key}`,
        },
      );
      return new Response(html, {
        headers: { ...noCache, 'Content-Type': 'text/html; charset=utf-8' },
      });
    })
    .get('/:key/info', async ({ params }) => {
      const result = await readText(params.key);
      if (!result) return notFound();
      const { file, content } = result;
      return Response.json(
        {
          title: file.pasteTitle,
          content,
          createdAt: file.createdAt,
          expiresAt: file.expiresAt,
          size: file.size,
          sha256: file.sha256,
          url: `${BASE_URL}/texts/${file.key}`,
          rawUrl: `${BASE_URL}/texts/${file.key}/raw`,
        },
        { headers: noCache },
      );
    })
    .get('/:key/raw', async ({ params }) => {
      const result = await readText(params.key);
      if (!result) return notFound();
      const { file } = result;
      return new Response(null, {
        status: 302,
        headers: {
          ...noCache,
          Location: `${FILES_URL}/uploads/${file.expiresAt ? 'temp/' : ''}${file.filename}?fn=${encodeURIComponent(file.realFilename)}&v=3&download=1`,
        },
      });
    });
