import path from 'path';
import pkg from '../../package.json';

export const PORT = process.env.PORT ?? 3000;
export const UPLOADS_DIR =
  process.env.UPLOADS_DIRECTORY ??
  path.resolve(import.meta.dirname, '../uploads');

export const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
export const WEB_NAME =
  BASE_URL.replace(/^https?:\/\/([^\/]+).*/, '$1') ?? 'sankyuu';

export const PROJECT_VERSION = pkg.version;
export const PROJECT_BUILD_DATE = pkg.buildDate
  ? new Date(pkg.buildDate)
  : undefined;

export const SHOULD_REDIRECT = process.env.SHOULD_REDIRECT === 'true';
export const CLEANUP_PERIOD = 0.5; // in hours

export const UNITS_TIME: Record<string, number> = {
  d: 24,
  h: 1,
  m: 1 / 60,
  s: 1 / 3600,
}; // in hours
