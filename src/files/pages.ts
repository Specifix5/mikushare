import { Elysia } from 'elysia';
import path from 'path';
import { db, getFile, type MikuFile } from '../db/client';
import { BASE_URL, FILES_URL, UPLOADS_DIR } from '../config/constants';
import { isStoredFile } from './storage';
import { withEmbedMetadata } from '../sharing/embeds';
import { byteRange, fileKind } from './view';
import { readMediaMetadata } from './metadata';
import { contentDisposition } from './filenames';
import { collectionFileContext } from '../collections/service';

const noCache = {
  'Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
};
const missing = () =>
  new Response('File not found', { status: 404, headers: noCache });
const storedPath = (file: MikuFile) =>
  path.join(UPLOADS_DIR, file.expiresAt ? 'temp' : '', file.filename);
const fileInfo = (file: MikuFile) => {
  const mime =
    Bun.file(storedPath(file)).type.split(';')[0] ?? 'application/octet-stream';
  const rawUrl = `${FILES_URL}/uploads/${file.expiresAt ? 'temp/' : ''}${encodeURIComponent(file.filename)}?fn=${encodeURIComponent(file.realFilename)}&v=3`;
  return {
    name: file.realFilename || file.filename,
    size: file.size,
    mime,
    kind: fileKind(mime),
    createdAt: file.createdAt,
    expiresAt: file.expiresAt,
    sha256: file.sha256,
    url: `${BASE_URL}/${encodeURIComponent(file.key)}`,
    rawUrl,
    downloadUrl: `${rawUrl}&download=1`,
    previewUrl: `/file-preview/${encodeURIComponent(file.key)}`,
    infoUrl: `/file-info/${encodeURIComponent(file.key)}`,
  };
};

const pageInfo = async (file: MikuFile, request?: Request) => {
  const info = fileInfo(file);
  const key = request
    ? new URL(request.url).searchParams.get('collection')
    : null;
  const collection = key ? await collectionFileContext(file.id, key) : null;
  const query = collection
    ? `?collection=${encodeURIComponent(collection.key)}`
    : '';
  return {
    ...info,
    collection,
    url: info.url + query,
    infoUrl: info.infoUrl + query,
  };
};

export const renderFilePage = async (file: MikuFile, request?: Request) => {
  const info = await pageInfo(file, request);
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character]!,
    );
  const replacements: Record<string, string> = {
    __FILE_NAME__: info.collection
      ? `<a href="${escape(info.collection.url)}">${escape(info.collection.name)}</a> / ${escape(info.collection.fileName)}`
      : escape(info.name),
    __FILE_DOWNLOAD__: escape(info.downloadUrl),
    __FILE_DATA__: JSON.stringify(info).replace(/</g, '\\u003c'),
  };
  const html = (await Bun.file('dist/pages/file.html').text()).replace(
    /__FILE_(?:NAME|DOWNLOAD|DATA)__/g,
    (token) => replacements[token]!,
  );
  return new Response(
    withEmbedMetadata(html, {
      title: info.collection
        ? `${info.collection.name} / ${info.collection.fileName}`
        : info.name,
      description: `File uploaded · ${info.size} bytes · ${info.mime}`,
      url: info.url,
      ...(info.kind === 'image' ? { image: info.rawUrl } : {}),
    }),
    {
      headers: {
        ...noCache,
        'Content-Type': 'text/html; charset=utf-8',
        Vary: 'User-Agent, Accept, Sec-Fetch-Dest',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
};

const available = async (key: string) => {
  const file = await getFile(db, key);
  if (
    !file ||
    (file.expiresAt && file.expiresAt <= new Date()) ||
    !(await isStoredFile(storedPath(file)))
  )
    return null;
  return file;
};

export const filePageRoutes = () =>
  new Elysia()
    .get('/file-info/:key', async ({ params, request }) => {
      const file = await available(params.key);
      if (!file) return missing();
      const info = await pageInfo(file, request);
      const metadata = await readMediaMetadata(storedPath(file), info.kind);
      return Response.json(
        {
          ...info,
          metadata: metadata.rows,
          metadataNote: metadata.note,
          title: metadata.title,
          artist: metadata.artist,
          coverUrl: metadata.cover
            ? `/file-cover/${encodeURIComponent(file.key)}`
            : null,
        },
        { headers: noCache },
      );
    })
    .get('/file-cover/:key', async ({ params }) => {
      const file = await available(params.key);
      if (!file) return missing();
      const { cover } = await readMediaMetadata(
        storedPath(file),
        fileInfo(file).kind,
      );
      if (!cover) return missing();
      return new Response(
        new Blob([new Uint8Array(cover.data)], { type: cover.type }),
        {
          headers: {
            ...noCache,
            'Content-Type': cover.type,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'",
          },
        },
      );
    })
    .get('/file-preview/:key', async ({ params, request }) => {
      const file = await available(params.key);
      if (!file) return missing();
      const info = fileInfo(file);
      if (info.kind === 'file') return missing();
      const blob = Bun.file(storedPath(file));
      const headers = new Headers({
        ...noCache,
        'Content-Type': info.mime,
        'Content-Disposition': contentDisposition(info.name, false),
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
        'Content-Security-Policy':
          info.kind === 'pdf'
            ? "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
            : "sandbox; default-src 'none'; frame-ancestors 'self'",
        'Referrer-Policy': 'no-referrer',
      });
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const range = byteRange(rangeHeader, blob.size);
        if (!range) {
          headers.set('Content-Range', `bytes */${blob.size}`);
          return new Response(null, { status: 416, headers });
        }
        headers.set(
          'Content-Range',
          `bytes ${range.start}-${range.end}/${blob.size}`,
        );
        headers.set('Content-Length', String(range.end - range.start + 1));
        return new Response(blob.slice(range.start, range.end + 1), {
          status: 206,
          headers,
        });
      }
      headers.set('Content-Length', String(blob.size));
      return new Response(blob, { headers });
    });
