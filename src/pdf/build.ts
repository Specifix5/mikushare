import { cp, mkdir, readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';
import { brotliCompressSync, gzipSync } from 'zlib';

export const buildPDF = async () => {
  const target = 'dist/public/pdf';
  await mkdir(target, { recursive: true });
  for (const [source, name, external] of [
    ['src/pdf/viewer.js', 'viewer.min.js', ['./export.min.js']],
    ['src/pdf/export.js', 'export.min.js', []],
    ['src/pdf/viewer.css', 'viewer.min.css', []],
    ['src/pdf/worker.js', 'pdf.worker.min.mjs', []],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [source],
      outdir: target,
      naming: name,
      target: 'browser',
      format: 'esm',
      minify: true,
      external: [...external],
    });
    if (!result.success)
      throw new Error(result.logs.map((log) => log.message).join('\n'));
  }
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
    await cp(`node_modules/pdfjs-dist/${directory}`, `${target}/${directory}`, {
      recursive: true,
    });
  await writeFile(
    `${target}/LICENSES.txt`,
    'PDF.js — Mozilla Foundation, Apache-2.0\n' +
      (await readFile('node_modules/pdfjs-dist/LICENSE', 'utf8')) +
      '\n\nPDF-Lib — MIT\n' +
      (await readFile('node_modules/pdf-lib/LICENSE.md', 'utf8')),
  );
  const compress = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await compress(filename);
      else {
        const bytes = await readFile(filename);
        if (bytes.length < 1024) continue;
        await writeFile(filename + '.br', brotliCompressSync(bytes));
        await writeFile(filename + '.gz', gzipSync(bytes, { level: 9 }));
      }
    }
  };
  await compress(target);
};
