import path from 'path';

export const PORT = process.env.PORT ?? 3000;
export const UPLOADS_DIR =
  process.env.UPLOADS_DIRECTORY ??
  path.resolve(import.meta.dirname, '../uploads');

export const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
