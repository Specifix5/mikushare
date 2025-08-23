import { exists } from 'fs/promises';
import { getFile, withTransaction } from './db/client';
import {
  BASE_URL,
  FILES_URL,
  SHOULD_REDIRECT,
  UPLOADS_DIR,
} from './utils/constants';
import path from 'path';
import { info } from './cli';
import { isCrawler, sanitizeFilename } from './utils/helpers';

export const getCacheControl = (temp?: boolean): string => {
  return temp ? 'public, max-age=3600' : 'public, max-age=31536000, immutable'; // let cf serve up to a year
};

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

  const mime =
    Bun.file(fileMetadata.filename).type || 'application/octet-stream';

  const cacheControl = getCacheControl(!!fileMetadata.expiresAt);

  const redirectLocation = `${FILES_URL}/uploads/${fileMetadata.expiresAt ? 'temp/' : ''}${fileMetadata.filename}?fn=${encodeURIComponent(fileMetadata.realFilename)}`;
  if (isCrawler(request.headers.get('user-agent')) && mime.includes('image')) {
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
};

export const GetFileUploads = async ({
  params,
  request,
  temp,
}: {
  params: { id: string };
  request: Request;
  temp?: boolean;
}) => {
  const { id } = params;
  const url = new URL(request.url);
  const filepath = path.join(UPLOADS_DIR, temp ? './temp/' : './', id);

  if (
    (await exists(filepath)) &&
    path.normalize(filepath).startsWith(UPLOADS_DIR) // Prevent directory traversal
  ) {
    const file = Bun.file(filepath);
    const stat = await file.stat();
    const mime = file.type || 'application/octet-stream';

    const cacheControl = getCacheControl(temp);

    const filename = url.searchParams.get('fn') ?? path.basename(filepath);

    const headers = {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
      'Content-Length': String(stat.size),
      'Content-Disposition': `inline; filename="${sanitizeFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Security-Policy': "default-src 'none'",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
      'Accept-Ranges': 'bytes',

      // for reverse proxies
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Redirect': '/_internal/uploads/' + (temp ? 'temp/' : '') + id,
      'X-Sendfile': filepath,

      ETag: `"${stat.size}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    };

    if (SHOULD_REDIRECT) {
      return new Response(null, {
        headers,
      });
    }

    return new Response(file, {
      headers,
    });
  }

  return new Response('Not Found', { status: 404 });
};
