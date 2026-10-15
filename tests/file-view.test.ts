import { expect, test } from 'bun:test';
import { byteRange, fileKind, wantsFilePage } from '../src/files/view';
import { metadataRows } from '../src/files/metadata';

test('file pages recognize browser navigations while preserving raw media and downloads', () => {
  const request = (headers: Record<string, string> = {}, query = '') =>
    new Request(`https://example.test/key${query}`, { headers });
  expect(
    wantsFilePage(request({ 'User-Agent': 'Mozilla/5.0 Firefox/140.0' })),
  ).toBe(true);
  expect(wantsFilePage(request({ 'Sec-Fetch-Dest': 'document' }))).toBe(true);
  expect(
    wantsFilePage(request({ Accept: 'text/html,application/xhtml+xml' })),
  ).toBe(true);
  expect(
    wantsFilePage(request({ Accept: 'text/html;q=0,application/json' })),
  ).toBe(false);
  expect(
    wantsFilePage(
      request({ 'User-Agent': 'Mozilla/5.0', 'Sec-Fetch-Dest': 'image' }),
    ),
  ).toBe(false);
  expect(
    wantsFilePage(
      request({ 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-10' }),
    ),
  ).toBe(false);
  expect(wantsFilePage(request({ Accept: 'text/html' }, '?download=1'))).toBe(
    false,
  );
  expect(wantsFilePage(request({ 'User-Agent': 'curl/8.0' }))).toBe(false);
  expect(wantsFilePage(request({}, '?view=1'))).toBe(true);
  expect(fileKind('text/html')).toBe('file');
  expect(fileKind('image/svg+xml')).toBe('file');
  expect(fileKind('application/pdf')).toBe('pdf');
});

test('media byte ranges handle suffixes, clamping, invalid and empty ranges', () => {
  expect(byteRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
  expect(byteRange('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
  expect(byteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
  expect(byteRange('bytes=2-999', 10)).toEqual({ start: 2, end: 9 });
  for (const range of [
    'bytes=10-',
    'bytes=4-2',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,4-5',
    'bytes=NaN-2',
  ])
    expect(byteRange(range, 10)).toBeNull();
  expect(byteRange('bytes=0-', 0)).toBeNull();
});

test('metadata preserves readable tags and dates while bounding binary and large fields', () => {
  const rows = metadataRows({
    title: '<script>test</script>',
    date: new Date('2026-01-01Z'),
    gps: { latitude: 35.6 },
    picture: [{ data: new Uint8Array(12) }],
    binary: new Uint8Array(12),
  });
  expect(rows).toContainEqual({
    label: 'title',
    value: '<script>test</script>',
  });
  expect(rows).toContainEqual({
    label: 'date',
    value: '2026-01-01T00:00:00.000Z',
  });
  expect(rows).toContainEqual({ label: 'gps / latitude', value: '35.6' });
  expect(rows).toHaveLength(3);
  expect(metadataRows({ large: 'x'.repeat(10000) })[0]!.value).toHaveLength(
    4096,
  );
});

test('file routes render safely, extract tags/art, seek bytes, and reject expired or executable files', async () => {
  // Keep database mocks in a subprocess so they cannot affect integration tests.
  const child = Bun.spawn(['bun', 'tests/helpers/file-page-fixture.mjs'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('File page route checks passed');
}, 20000);
