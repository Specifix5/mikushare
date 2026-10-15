import path from 'path';
import pkg from '../../package.json';
import { env } from './env';

export const PORT = env.PORT;
export const UPLOADS_DIR = path.resolve(env.UPLOADS_DIRECTORY);

export const BASE_URL = (env.BASE_URL ?? `http://localhost:${PORT}`).replace(
  /\/$/,
  '',
);
export const FILES_URL = (env.FILES_URL ?? BASE_URL).replace(/\/$/, '');
export const WEB_NAME =
  BASE_URL.replace(/^https?:\/\/([^\/]+).*/, '$1') ?? 'sankyuu';

export const PROJECT_VERSION = pkg.version;
export const PROJECT_BUILD_DATE = pkg.buildDate
  ? new Date(pkg.buildDate)
  : undefined;

export const PROJECT_DESCRIPTION = 'welcome to miku file sharing!!! meow';

export const SHOULD_REDIRECT = env.SHOULD_REDIRECT;
export const MAX_FILE_SIZE = env.MAX_FILE_SIZE;
export const MAX_TEMP_FILE_SIZE = env.MAX_TEMP_FILE_SIZE;
export const MAX_TEXT_SIZE = env.MAX_TEXT_SIZE;
export const MAX_BATCH_FILE_SIZE =
  env.MAX_BATCH_FILE_SIZE ?? MAX_TEMP_FILE_SIZE;
export const MAX_UPLOAD_FILES = env.MAX_UPLOAD_FILES;

export const CLEANUP_PERIOD = 0.5; // in hours

export const UNITS_TIME: Record<string, number> = {
  d: 24,
  h: 1,
  m: 1 / 60,
  s: 1 / 3600,
}; // in hours
