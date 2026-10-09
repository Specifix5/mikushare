import { writeFile } from 'fs/promises';
import { cp, rm, readFile, readdir } from 'fs/promises';
import {
  MAX_BATCH_FILE_SIZE,
  MAX_FILE_SIZE,
  MAX_TEMP_FILE_SIZE,
  MAX_TEXT_SIZE,
  MAX_UPLOAD_FILES,
} from '../src/utils/constants';
import ejs from 'ejs';
import path from 'path';
import {
  PROJECT_BUILD_DATE,
  PROJECT_DESCRIPTION,
  PROJECT_VERSION,
  WEB_NAME,
} from '../src/utils/constants';
import { mkdir } from 'fs/promises';
import { unlink } from 'fs/promises';

const pageDir = path.resolve('./src/pages');
const replacements: Record<string, string> = {
  '{%maxSize%}': String(MAX_FILE_SIZE),
  '{%maxTempSize%}': String(MAX_TEMP_FILE_SIZE),
  '{%maxTextSize%}': String(MAX_TEXT_SIZE),
  '{%maxBatchSize%}': String(MAX_BATCH_FILE_SIZE),
  '{%maxFiles%}': String(MAX_UPLOAD_FILES),
};

export async function render(view: string, data: object = {}): Promise<string> {
  const filePath = path.join(pageDir, view);
  const template = await readFile(filePath, 'utf-8');
  return ejs.render(
    template,
    {
      css: `${Date.now()}`,
      webname: WEB_NAME,
      description: PROJECT_DESCRIPTION,
      project_version: PROJECT_VERSION,
      max_size: MAX_FILE_SIZE,
      max_temp_size: MAX_TEMP_FILE_SIZE,
      max_text_size: MAX_TEXT_SIZE,
      max_batch_size: MAX_BATCH_FILE_SIZE,
      max_files: MAX_UPLOAD_FILES,
      script: 'index',
      build_date: PROJECT_BUILD_DATE
        ? PROJECT_BUILD_DATE.toISOString()
            .slice(0, 10)
            .replace(/(\d{4})-(\d{2})-(\d{2})/, '$1年$2月$3日')
        : '',
      ...data,
    },
    {
      filename: filePath,
    },
  );
}

async function build() {
  // Set the timestamp before bundling and rendering so all outputs agree.
  const packageJSON = JSON.parse(
    await readFile('./package.json', 'utf-8'),
  ) as Record<string, unknown> & { buildDate: string };
  packageJSON.buildDate = new Date().toISOString();
  await writeFile(
    './package.json',
    JSON.stringify(packageJSON, null, 2) + '\n',
  );
  // clean dist
  await rm('dist', { recursive: true, force: true });

  // bundle code
  const server = await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'bun',
  });
  if (!server.success)
    throw new Error(server.logs.map((log) => log.message).join('\n'));

  await cp('src/public', 'dist/public', { recursive: true });
  await mkdir('dist/pages', { recursive: true });

  // render all pages
  const pages = await readdir('src/pages');
  for (const file of pages) {
    const targetPath = `./dist/pages/${file.replace(/\.ejs$/, '.html')}`;
    if (file.endsWith('.ejs')) {
      await writeFile(
        targetPath,
        await render(file, {
          build_date: new Date(packageJSON.buildDate)
            .toISOString()
            .slice(0, 10)
            .replace(/(\d{4})-(\d{2})-(\d{2})/, '$1年$2月$3日'),
          script: ['404.ejs', '500.ejs'].includes(file)
            ? false
            : file === 'index.ejs'
              ? 'index'
              : file.startsWith('admin')
                ? 'admin'
                : file === 'text.ejs'
                  ? 'text'
                  : 'collection',
        }),
      );
    }
  }

  // minify and replace all places of {%maxSize%} and {%maxTempSize%} in public/scripts
  const scripts = await readdir('dist/public/scripts');
  for (const file of scripts) {
    const filePath = `dist/public/scripts/${file}`;
    if (file.endsWith('.js')) {
      let content = await readFile(filePath, 'utf-8');
      for (const [pattern, value] of Object.entries(replacements)) {
        content = content.replaceAll(pattern, value);
      }
      await writeFile(filePath, content);

      const result = await Bun.build({
        entrypoints: [filePath],
        outdir: path.join('dist/public/scripts'),
        minify: true,
        naming: file.replace(/\.js$/, '.min.js'),
        plugins: [
          {
            name: 'shared-filenames',
            setup(build) {
              build.onResolve({ filter: /^@miku\/filenames$/ }, () => ({
                path: path.resolve('src/utils/filenames.ts'),
              }));
            },
          },
        ],
      });
      if (!result.success)
        throw new Error(result.logs.map((log) => log.message).join('\n'));

      await unlink(filePath);
    }
  }

  // minify css
  const files = await readdir('dist/public/styles');
  for (const file of files) {
    const filePath = `dist/public/styles/${file}`;
    if (file.endsWith('.css')) {
      let content = await readFile(filePath, 'utf-8');
      for (const [pattern, value] of Object.entries(replacements)) {
        content = content.replaceAll(pattern, value);
      }
      await writeFile(filePath, content);

      const result = await Bun.build({
        entrypoints: [filePath],
        outdir: path.join('dist/public/styles'),
        minify: true,
        naming: file.replace(/\.css$/, '.min.css'),
      });
      if (!result.success)
        throw new Error(result.logs.map((log) => log.message).join('\n'));

      await unlink(filePath);
    }
  }

  console.log('[build] Build finished!');
}

await build();
