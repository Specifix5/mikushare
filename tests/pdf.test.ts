import { expect, test } from 'bun:test';
import { brotliDecompressSync, gunzipSync } from 'zlib';
import {
  annotationStore,
  hitsAnnotation,
  pointOnPage,
  validateAnnotations,
} from '../src/pdf/annotations.js';
import { pdfAssetResponse } from '../src/pdf/assets';

const pen = {
  page: 1,
  tool: 'pen',
  color: '#a6e3a1',
  width: 2,
  points: [
    { x: 10, y: 20 },
    { x: 50, y: 20 },
  ],
};

test('SVG coordinates stay in page space across zoom and clamp to page edges', () => {
  expect(
    pointOnPage(
      { clientX: 50, clientY: 75 },
      { left: 0, top: 0, width: 100, height: 200 },
      400,
      800,
    ),
  ).toEqual({ x: 200, y: 300 });
  expect(
    pointOnPage(
      { clientX: 100, clientY: 150 },
      { left: 0, top: 0, width: 200, height: 400 },
      400,
      800,
    ),
  ).toEqual({ x: 200, y: 300 });
  expect(
    pointOnPage(
      { clientX: -5, clientY: 900 },
      { left: 0, top: 0, width: 200, height: 400 },
      400,
      800,
    ),
  ).toEqual({ x: 0, y: 800 });
});

test('annotations undo/redo across pages, erase only hit marks, and drop obsolete redo history', () => {
  const store = annotationStore();
  store.add(pen);
  store.add({ ...pen, page: 2 });
  store.erase(1, { x: 30, y: 21 }, 5);
  expect(store.marks.map((mark) => mark.page)).toEqual([2]);
  store.undo();
  expect(store.marks).toHaveLength(2);
  store.undo();
  expect(store.marks).toHaveLength(1);
  store.redo();
  expect(store.marks).toHaveLength(2);
  store.undo();
  store.add({ ...pen, page: 3 });
  expect(store.canRedo).toBe(false);
  expect(hitsAnnotation(pen, { x: 200, y: 200 })).toBe(false);
  expect(
    hitsAnnotation(
      {
        ...pen,
        tool: 'highlight',
        points: [
          { x: 5, y: 5 },
          { x: 20, y: 20 },
        ],
      },
      { x: 10, y: 10 },
    ),
  ).toBe(true);
});

test('stored annotations reject executable markup, invalid pages and oversized/invalid geometry', () => {
  expect(validateAnnotations([pen], 3)).toEqual([pen]);
  for (const invalid of [
    { ...pen, color: '<svg onload=alert(1)>' },
    { ...pen, page: 4 },
    { ...pen, width: 999 },
    {
      ...pen,
      points: [
        { x: NaN, y: 1 },
        { x: 1, y: 2 },
      ],
    },
    { ...pen, points: Array.from({ length: 2001 }, () => ({ x: 1, y: 1 })) },
  ])
    expect(validateAnnotations([invalid], 3)).toEqual([]);
});

test('PDF assets negotiate compression, retain JavaScript MIME and support conditional caching', async () => {
  const url = 'http://localhost/public/pdf/viewer.min.js';
  const identity = await pdfAssetResponse(
    new Request(url, { headers: { 'Accept-Encoding': 'br;q=0,gzip;q=0' } }),
  );
  expect(identity.status).toBe(200);
  expect(identity.headers.has('Content-Encoding')).toBe(false);
  const source = Buffer.from(await identity.arrayBuffer());
  for (const [encoding, decompress] of [
    ['br', brotliDecompressSync],
    ['gzip', gunzipSync],
  ] as const) {
    const response = await pdfAssetResponse(
      new Request(url, { headers: { 'Accept-Encoding': encoding } }),
    );
    expect(response.headers.get('Content-Encoding')).toBe(encoding);
    expect(response.headers.get('Content-Type')).toContain('javascript');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(decompress(Buffer.from(await response.arrayBuffer()))).toEqual(
      source,
    );
    const cached = await pdfAssetResponse(
      new Request(url, {
        headers: {
          'Accept-Encoding': encoding,
          'If-None-Match': response.headers.get('ETag')!,
        },
      }),
    );
    expect(cached.status).toBe(304);
  }
  expect(
    (
      await pdfAssetResponse(
        new Request('http://localhost/public/pdf/%2e%2e%2findex.js'),
      )
    ).status,
  ).toBe(404);
  expect((await pdfAssetResponse(new Request(url + '.br'))).status).toBe(404);
});
