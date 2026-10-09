import 'dotenv/config';
import { z } from 'zod';

const positive = z.coerce.number().finite().positive();
const boolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
const list = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
const httpURL = z
  .url()
  .refine((value) => /^https?:\/\//.test(value), 'Use an HTTP or HTTPS URL');

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  BASE_URL: httpURL.optional(),
  FILES_URL: httpURL.optional(),
  UPLOADS_DIRECTORY: z.string().trim().min(1).default('./uploads'),
  MAX_FILE_SIZE: positive.default(65),
  MAX_TEMP_FILE_SIZE: positive.default(95),
  MAX_BATCH_FILE_SIZE: positive.optional(),
  MAX_TEXT_SIZE: positive.default(1),
  SHOULD_REDIRECT: boolean.default(false),
  INIT_CLEANUP: boolean.default(true),
  ADMIN_USERS: list,
  ADMIN_TOKENS: list,
  ZIP_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(604800)
    .default(3600),
  ZIP_CACHE_DIRECTORY: z.string().trim().min(1).default('./cache/zips'),
  ZIP_CACHE_MAX_MB: positive.default(1024),
  ZIP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(4),
  DB_HOST: z.string().trim().min(1).optional(),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_USER: z.string().min(1).optional(),
  DB_PASSWORD: z.string().min(1).optional(),
  DB_NAME: z.string().min(1).optional(),
});

export const parseEnv = (values: Record<string, unknown>) => {
  const result = envSchema.safeParse(values);
  if (!result.success) {
    // Report variable names without exposing credentials from the input.
    throw new Error(
      'Invalid environment variables: ' +
        result.error.issues.map((issue) => issue.path.join('.')).join(', '),
    );
  }
  return result.data;
};

export const env = parseEnv(process.env);

export const databaseURL = () => {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = env;
  if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
    throw new Error('Set DB_HOST, DB_USER, DB_PASSWORD and DB_NAME');
  }
  return `postgres://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${encodeURIComponent(DB_NAME)}`;
};
