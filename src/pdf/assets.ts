import { Elysia } from 'elysia';
import path from 'path';
import { stat } from 'fs/promises';

const root = path.resolve('dist/public/pdf');
const quality = (header: string, encoding: string) => {
  const values = header.split(',').map((part) => {
    const [name, ...options] = part.trim().split(';');
    const value = options.find((option) => option.trim().startsWith('q='));
    return { name, quality: value ? Number(value.split('=')[1]) : 1 };
  });
  return (
    values.find((value) => value.name === encoding)?.quality ??
    values.find((value) => value.name === '*')?.quality ??
    0
  );
};

export const pdfAssetResponse = async (request: Request) => {
  let relative: string;
  try {
    relative = decodeURIComponent(
      new URL(request.url).pathname.slice('/public/pdf/'.length),
    );
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  if (
    !relative ||
    !/^[\w./-]+$/.test(relative) ||
    relative.split('/').includes('..')
  )
    return new Response('Not Found', { status: 404 });
  const original = path.resolve(root, relative);
  if (!original.startsWith(root + path.sep) || /\.(br|gz)$/.test(relative))
    return new Response('Not Found', { status: 404 });
  const file = Bun.file(original);
  if (!(await file.exists())) return new Response('Not Found', { status: 404 });
  const accept = request.headers.get('accept-encoding') ?? '';
  const choices = [
    { name: 'br', suffix: '.br' },
    { name: 'gzip', suffix: '.gz' },
  ]
    .filter((value) => quality(accept, value.name) > 0)
    .sort((a, b) => quality(accept, b.name) - quality(accept, a.name));
  let target = file,
    encoding = '';
  for (const choice of choices) {
    const compressed = Bun.file(original + choice.suffix);
    if (await compressed.exists()) {
      target = compressed;
      encoding = choice.name;
      break;
    }
  }
  const metadata = await stat(original);
  const etag = `"${metadata.size}-${Math.floor(metadata.mtimeMs)}-${encoding || 'identity'}"`;
  const headers = new Headers({
    'Content-Type': /\.(mjs|js)$/.test(relative)
      ? 'text/javascript; charset=utf-8'
      : file.type,
    'Cache-Control': 'public, max-age=86400',
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
  });
  if (encoding) headers.set('Content-Encoding', encoding);
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  headers.set('Content-Length', String(target.size));
  return new Response(request.method === 'HEAD' ? null : target, { headers });
};

export const pdfAssetRoutes = () =>
  new Elysia()
    .get('/public/pdf/*', ({ request }) => pdfAssetResponse(request))
    .head('/public/pdf/*', ({ request }) => pdfAssetResponse(request));
