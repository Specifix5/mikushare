import { readFile } from 'fs/promises';
import ejs from 'ejs';
import path from 'path';
import { PROJECT_BUILD_DATE, PROJECT_VERSION, WEB_NAME } from './constants';

const pageDir = path.resolve('./dist/pages');
const pageCache: Record<string, string> = {};

export async function render(view: string, data: object = {}): Promise<string> {
  const filePath = path.join(pageDir, view + '.ejs');
  pageCache[filePath] ??= await readFile(filePath, 'utf-8');
  const template = pageCache[filePath];
  return ejs.render(
    template,
    {
      css: `${Date.now()}`,
      webname: WEB_NAME,
      project_version: PROJECT_VERSION,
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
