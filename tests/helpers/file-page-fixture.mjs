import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { createHash } from 'node:crypto';

const directory = await mkdtemp(path.join(tmpdir(), 'miku-file-pages-'));
process.env.UPLOADS_DIRECTORY = directory;
let handler = () => new Response('Starting', { status: 503 });
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => handler(request),
});
const base = server.url.origin;
process.env.BASE_URL = base;
process.env.FILES_URL = `${base}/files`;
const records = new Map();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

const add = async (key, filename, bytes, name = filename) => {
  await Bun.write(path.join(directory, filename), bytes);
  const file = {
    id: records.size + 1,
    key,
    filename,
    size: bytes.length,
    realFilename: name,
    ownerId: 1,
    pasteTitle: null,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: new Date('2026-01-01Z'),
    expiresAt: null,
  };
  records.set(key, file);
  return file;
};
const wav = Buffer.alloc(44 + 8000 * 2 * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 16000; i++)
  wav.writeInt16LE(
    Math.round(Math.sin((i * 2 * Math.PI * 440) / 8000) * 12000),
    44 + i * 2,
  );
const tag = (id, data) => {
  const header = Buffer.alloc(10);
  header.write(id);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
};
const tags = Buffer.concat([
  tag('TIT2', Buffer.from('\0Fixture song')),
  tag('TPE1', Buffer.from('\0Fixture artist')),
  tag('TALB', Buffer.from('\0Fixture album')),
  tag('APIC', Buffer.concat([Buffer.from('\0image/png\0\x03\0'), png])),
]);
const id3 = Buffer.from([
  0x49,
  0x44,
  0x33,
  3,
  0,
  0,
  (tags.length >> 21) & 127,
  (tags.length >> 14) & 127,
  (tags.length >> 7) & 127,
  tags.length & 127,
]);
const frame = Buffer.alloc(417);
frame.set([0xff, 0xfb, 0x90, 0x64]);
const mp3 = Buffer.concat([
  id3,
  tags,
  ...Array.from({ length: 40 }, () => frame),
]);
const pdfObjects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  '<< /Length 48 >>\nstream\nBT /F1 18 Tf 30 230 Td (File preview) Tj ET\nendstream',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
pdfObjects.forEach((object, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
  .join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
await add('image', 'pixel.png', png);
await add('audio', 'tone.wav', wav);
await add('tags', 'song.mp3', mp3);
await add('pdf', 'sample.pdf', Buffer.from(pdf));
const multi = await PDFDocument.create();
const font = await multi.embedFont(StandardFonts.Helvetica);
for (let index = 0; index < 3; index++) {
  const page = multi.addPage([400, 500]);
  page.drawText(`Vector PDF page ${index + 1}`, {
    x: 30,
    y: 400,
    size: 20,
    font,
  });
  if (index === 1) page.setRotation(degrees(90));
}
await add('multipdf', 'three-pages.pdf', await multi.save());
await add('invalidpdf', 'broken.pdf', Buffer.from('Not a PDF document'));
await add(
  'unknown',
  'archive.bin',
  Buffer.from('unknown file'),
  '__FILE_DATA__ </script><script>alert(1)</script>.bin',
);
await add('html', 'unsafe.html', Buffer.from('<script>alert(1)</script>'));
const expired = await add(
  'expired',
  'expired.bin',
  Buffer.from('expired secret'),
);
expired.expiresAt = new Date('2020-01-01Z');
mock.module('../../src/db/client', () => ({
  db: {},
  getFile: (_db, key) => records.get(key),
  withTransaction: (callback) => callback({}),
  keyExists: () => false,
}));
const { Elysia } = await import('elysia');
const { filePageRoutes } = await import('../../src/files/pages');
const { GetFileHandler } = await import('../../src/files/routes');
const { qrCodeHandler } = await import('../../src/sharing/qrcode');
const { pdfAssetRoutes } = await import('../../src/pdf/assets');
const app = new Elysia()
  .get('/', () => new Response(Bun.file('dist/pages/index.html')))
  .use(filePageRoutes())
  .use(pdfAssetRoutes())
  .get('/qrcode', qrCodeHandler)
  .get(
    '/public/*',
    ({ params }) =>
      new Response(Bun.file(path.join('dist/public', params['*']))),
  )
  .get('/:id', GetFileHandler);
handler = (request) => app.handle(request);
const cleanup = async () => {
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
};
if (process.argv.includes('--serve')) {
  console.log(`FILE_PAGE_FIXTURE_URL=${base}`);
  process.on('SIGTERM', () => {
    void cleanup().then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(0));
  });
} else {
  try {
    const request = (route, headers = {}) =>
      fetch(base + route, { headers, redirect: 'manual' });
    for (const key of ['image', 'audio', 'pdf', 'unknown', 'tags']) {
      const page = await request('/' + key, {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 Firefox/140.0',
      });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /data-file-actions/);
      assert.match(html, /Embedded metadata/);
      assert.match(html, /\/files\/uploads\//);
      assert(!html.includes('<script>alert(1)</script>'));
      assert(page.headers.get('vary').includes('Accept'));
    }
    const raw = await request('/audio', { 'User-Agent': 'curl/8' });
    assert.equal(raw.status, 302);
    const download = await request('/audio?download=1', {
      Accept: 'text/html',
    });
    assert.equal(download.status, 302);
    assert(download.headers.get('location').includes('download=1'));
    const crawler = await request('/image', {
      'User-Agent': 'Discordbot/2.0',
      Accept: 'text/html',
    });
    assert.match(await crawler.text(), /og:image/);
    const partial = await request('/file-preview/audio', {
      Range: 'bytes=12-23',
    });
    assert.equal(partial.status, 206);
    assert.equal(
      partial.headers.get('content-range'),
      `bytes 12-23/${wav.length}`,
    );
    assert.deepEqual(
      Buffer.from(await partial.arrayBuffer()),
      wav.subarray(12, 24),
    );
    assert.equal(
      (await request('/file-preview/audio', { Range: 'bytes=999999-' })).status,
      416,
    );
    assert.equal(
      (await request('/file-preview/pdf')).headers.get('content-type'),
      'application/pdf',
    );
    assert.equal((await request('/file-preview/html')).status, 404);
    const imageInfo = await (await request('/file-info/image')).json();
    assert.equal(imageInfo.kind, 'image');
    assert.equal(imageInfo.metadata.length, 0);
    const audioInfo = await (await request('/file-info/audio')).json();
    assert.equal(audioInfo.metadata.length, 0);
    const info = await (await request('/file-info/tags')).json();
    assert.equal(info.title, 'Fixture song');
    assert.equal(info.artist, 'Fixture artist');
    assert.equal(info.coverUrl, '/file-cover/tags');
    const cover = await request(info.coverUrl);
    assert.equal(cover.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), png);
    for (const route of [
      '/expired',
      '/file-info/expired',
      '/file-preview/expired',
      '/file-cover/expired',
      '/missing',
    ])
      assert.equal((await request(route, { Accept: 'text/html' })).status, 404);
    await rm(path.join(directory, 'pixel.png'));
    assert.equal((await request('/file-info/image')).status, 404);
    assert.equal((await request('/file-preview/image')).status, 404);
    console.log('File page route checks passed');
  } finally {
    await cleanup();
  }
}
