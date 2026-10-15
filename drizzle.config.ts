import { defineConfig } from 'drizzle-kit';
import { databaseURL } from './src/config/env';

const url = databaseURL();

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url,
  },
  verbose: true,
});
