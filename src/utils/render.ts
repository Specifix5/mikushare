import { readFile } from 'fs/promises';
import ejs from 'ejs';
import path from 'path';

const pageDir = path.resolve('./dist/pages');
const pageCache: Record<string, string> = {};

export const RANDOM_BUILD_NUMBER = Math.floor(Math.random() * 1000);

export async function render(view: string, data: object = {}): Promise<string> {
  const filePath = path.join(pageDir, view + '.ejs');
  if (!pageCache[filePath]) {
    pageCache[filePath] = await readFile(filePath, 'utf-8');
  }
  const template = pageCache[filePath];
  return ejs.render(
    template,
    {
      css: `${RANDOM_BUILD_NUMBER}`,
      ...data,
    },
    {
      filename: filePath,
    },
  );
}
