import { lstat, realpath } from 'fs/promises';
import { db, getFile, withTransaction } from '../db/client';
import { files } from '../db/schema';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import {
  BASE_URL,
  FILES_URL,
  SHOULD_REDIRECT,
  UPLOADS_DIR,
} from '../config/constants';
import path from 'path';
import { info } from '../accounts/commands';
import { isCrawler } from '../core/helpers';
import { contentDisposition } from './filenames';
import { imageEmbedHead, isPreviewImage } from '../sharing/embeds';
import { uploadContent } from './content';
import { isStoredFile } from './storage';
import { wantsFilePage } from './view';
import { renderFilePage } from './pages';

export const getCacheControl = (temp?: boolean, expiresAt?: Date): string => {
  return temp
    ? `public, max-age=${expiresAt ? Math.max(0, Math.min(3600, Math.floor((expiresAt.getTime() - Date.now()) / 1000))) : 3600}`
    : 'public, max-age=31536000, immutable'; // let cf serve up to a year
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

  if (fileMetadata.expiresAt && fileMetadata.expiresAt <= new Date()) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const filepath = path.join(
    UPLOADS_DIR,
    fileMetadata.expiresAt ? 'temp' : '',
    fileMetadata.filename,
  );
  if (!(await isStoredFile(filepath)))
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });

  const download = new URL(request.url).searchParams.get('download') === '1';
  if (fileMetadata.pasteTitle !== null && !download)
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${BASE_URL}/texts/${fileMetadata.key}`,
        'Cache-Control': 'no-store',
      },
    });
  const redirectLocation = `${FILES_URL}/uploads/${fileMetadata.expiresAt ? 'temp/' : ''}${fileMetadata.filename}?fn=${encodeURIComponent(fileMetadata.realFilename)}&v=3${download ? '&download=1' : ''}`;
  if (
    isCrawler(request.headers.get('user-agent')) &&
    isPreviewImage(fileMetadata.filename)
  ) {
    const fileUrl = `${FILES_URL}/uploads/${fileMetadata.expiresAt ? 'temp/' : ''}${fileMetadata.filename}?fn=${encodeURIComponent(fileMetadata.realFilename)}&v=3`;
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8" />${imageEmbedHead(fileUrl)}</head></html>`,
      {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          Vary: 'User-Agent',
        },
      },
    );
  }

  if (!isCrawler(request.headers.get('user-agent')) && wantsFilePage(request))
    return renderFilePage(fileMetadata, request);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectLocation,
      'Cache-Control': 'no-store',
      Vary: 'User-Agent, Accept, Sec-Fetch-Dest',
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
  if (!id || /[\\/\x00-\x1f:\x7f]/.test(id) || id === '.' || id === '..')
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  const directory = path.resolve(UPLOADS_DIR, temp ? 'temp' : '');
  const filepath = path.resolve(directory, id);
  const [metadata] = await db
    .select({ expiresAt: files.expiresAt })
    .from(files)
    .where(
      and(
        eq(files.filename, id),
        temp ? isNotNull(files.expiresAt) : isNull(files.expiresAt),
      ),
    )
    .limit(1);
  if (!metadata || (metadata.expiresAt && metadata.expiresAt <= new Date())) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const expiresAt = metadata.expiresAt ?? undefined;
  const stat = await lstat(filepath).catch((error: unknown) => {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return null;
    throw error;
  });
  if (
    stat?.isFile() &&
    filepath.startsWith(directory + path.sep) // Prevent directory traversal
  ) {
    const [root, resolved] = await Promise.all([
      realpath(UPLOADS_DIR),
      realpath(filepath),
    ]).catch((error: unknown) => {
      if (
        ['ENOENT', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return [null, null];
      throw error;
    });
    if (!root || !resolved?.startsWith(root + path.sep))
      return new Response('Not Found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    const file = Bun.file(filepath);
    const policy = uploadContent(
      file.type || 'application/octet-stream',
      url.searchParams.get('download') === '1',
    );

    const cacheControl =
      policy.type === 'application/octet-stream' ||
      policy.type === 'image/svg+xml'
        ? 'no-store'
        : getCacheControl(temp, expiresAt);

    const filename =
      (url.searchParams.get('fn')?.trim() ?? '') || path.basename(filepath);

    const headers = {
      'Content-Type': policy.type,
      'Cache-Control': cacheControl,
      'Content-Length': String(stat.size),
      'Content-Disposition': contentDisposition(filename, policy.attachment),
      'Content-Security-Policy':
        "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
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

  return new Response('Not Found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
};
