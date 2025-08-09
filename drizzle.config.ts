import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
const url = DB_HOST?.startsWith('postgres://')
  ? DB_HOST
  : `postgres://${encodeURIComponent(DB_USER ?? '')}:${encodeURIComponent(DB_PASSWORD ?? '')}@${
      DB_HOST ?? 'localhost'
    }:${DB_PORT ?? '5432'}/${DB_NAME ?? ''}`;

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url,
  },
  verbose: true,
});
