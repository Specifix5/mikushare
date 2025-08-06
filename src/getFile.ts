import { readFile } from 'fs/promises';
import { getFile, withTransaction } from './db/client';
import { BASE_URL, SHOULD_REDIRECT, UPLOADS_DIR } from './utils/constants';
import path from 'path';
import { file } from 'bun';
import { info } from './cli';
import { isCrawler } from './utils/helpers';

export const GetFileHandler = async ({
  params,
  request,
}: {
  params: { id: string };
  request: Request;
}) => {
  info('Main', request.headers.get('user-agent'), ' > ', request.url);

  const { id } = params;
  const fileMetadata = await withTransaction(async (tx) => {
    return getFile(tx, id);
  });
  if (!fileMetadata) return new Response('Not Found', { status: 404 });

  if (fileMetadata.expiresAt && new Date(fileMetadata.expiresAt) < new Date()) {
    return new Response('Not Found', { status: 404 });
  }

  const mime = file(fileMetadata.filename).type || 'application/octet-stream';

  const cacheControl = fileMetadata.expiresAt
    ? 'public, max-age=3600'
    : 'public, max-age=31536000, immutable'; // let cf serve up to a year

  if (SHOULD_REDIRECT) {
    const redirectLocation = `/uploads/${fileMetadata.expiresAt ? 'temp/' : ''}${fileMetadata.filename}`;
    if (
      isCrawler(request.headers.get('user-agent')) &&
      mime.includes('image')
    ) {
      const fileUrl = new URL(redirectLocation, BASE_URL).href;
      return new Response(
        `<!DOCTYPE html><html><head><meta property="og:image" content="${fileUrl}" /><meta property="og:type" content="image" /><meta name="twitter:card" content="summary_large_image" /></head></html>`,
        {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': cacheControl,
          },
        },
      );
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectLocation,
      },
    });
  }

  const buffer = await readFile(
    path.join(
      UPLOADS_DIR,
      fileMetadata.expiresAt ? './temp' : './',
      fileMetadata.filename,
    ),
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
    },
  });
};
