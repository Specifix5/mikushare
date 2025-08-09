import { drizzle, type BunSQLQueryResultHKT } from 'drizzle-orm/bun-sql';
import { SQL } from 'bun';
import { eq, isNotNull, lt, and, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'crypto';
import { readFile, readdir, stat, exists, mkdir } from 'fs/promises';
import { error, info, warn } from '../cli';
import { FailedToInsertUserError, KeyCollisionError } from './errors';
import { UPLOADS_DIR } from '../utils/constants';
import * as schema from './schema';
import path, { basename, extname } from 'path';
import type { ExtractTablesWithRelations, InferSelectModel } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;

if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) {
  throw new Error('Database environment variables are not fully set');
}

const connectionString = `postgres://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;

const client = new SQL(connectionString);

await client`SET TIME ZONE 'UTC'`;

export const db = drizzle({ client, schema });

export type DB = typeof db;

export type Tx = PgTransaction<
  BunSQLQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type DBLike = DB | Tx;

export type MikuUser = InferSelectModel<typeof schema.users>;
export type MikuFile = InferSelectModel<typeof schema.files>;

/**
 * Executes a given function within a database transaction.
 */
export async function withTransaction<T>(
  fn: (tx: DBLike) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

/**
 * Insert a new user with API key
 */
export const createUser = async (
  tx: DBLike,
  user: string,
  key?: string,
  expiryDate?: Date,
): Promise<MikuUser> => {
  const apiKey = key ?? `${user}_${randomBytes(16).toString('hex')}`;

  const [insertedUser] = await tx
    .insert(schema.users)
    .values({
      user,
      apiKey,
      // Postgres timestamptz: pass Date or null
      expiresAt: expiryDate ?? null,
      // createdAt uses DEFAULT NOW() in schema
    })
    .returning();

  if (!insertedUser) throw new FailedToInsertUserError();

  return insertedUser;
};

/**
 * Gets the user data by API key
 */
export const getUserFromKey = async (
  tx: DBLike,
  key: string,
): Promise<MikuUser | null> => {
  const result = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.apiKey, key))
    .limit(1);
  return result[0] ?? null;
};

/**
 * Gets the user data by username
 */
export const getUser = async (
  tx: DBLike,
  user: string,
): Promise<MikuUser | null> => {
  const result = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.user, user))
    .limit(1);
  return result[0] ?? null;
};

/**
 * Check if a user exists and their key is not expired
 */
export const userExists = async (
  tx: DBLike,
  user: string,
): Promise<boolean> => {
  const result = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.user, user))
    .limit(1);

  if (result.length === 0) return false;

  const u = result[0]!;
  if (u.expiresAt && u.expiresAt < new Date()) return false;

  return true;
};

/**
 * Deletes a user from the database.
 */
export const deleteUser = async (tx: DBLike, user: string): Promise<void> => {
  await tx.delete(schema.users).where(eq(schema.users.user, user));
};

export const deleteUserById = async (tx: DBLike, id: number): Promise<void> => {
  await tx.delete(schema.users).where(eq(schema.users.id, id));
};

/**
 * Check if key exists and is not expired
 */
export const keyExists = async (tx: DBLike, key: string): Promise<boolean> => {
  const result = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.apiKey, key))
    .limit(1);

  if (result.length === 0) return false;

  const u = result[0]!;
  if (u.expiresAt && u.expiresAt < new Date()) return false;

  return true;
};

/**
 * Insert the file into the database
 */
export const addFileWithKey = async (
  tx: DBLike,
  ownerId: number,
  key: string,
  filename: string,
  size: number,
  expiryDate?: Date,
): Promise<{ key: string; filename: string }> => {
  try {
    await tx.insert(schema.files).values({
      key,
      ownerId,
      filename,
      size,
      expiresAt: expiryDate ?? null, // timestamptz
      // createdAt defaultNow() in schema
    });
  } catch (e) {
    // Postgres unique violation
    if (
      typeof e === 'object' &&
      e &&
      'code' in e &&
      (e as { code: string }).code === '23505'
    ) {
      throw new KeyCollisionError();
    }
    throw e;
  }

  return { key, filename };
};

/**
 * Inserts a new file entry into the database.
 */
export const addFile = async (
  tx: DBLike,
  ownerId: number,
  extname: string,
  size: number,
  expiryDate?: Date,
): Promise<{ key: string; filename: string }> => {
  const key = randomBytes(6).toString('base64url');
  const filename = randomUUID() + extname;

  await addFileWithKey(tx, ownerId, key, filename, size, expiryDate);

  return { key, filename };
};

/**
 * Retrieves a file's metadata from the database.
 */
export const getFile = async (
  tx: DBLike,
  key: string,
): Promise<MikuFile | null> => {
  const result = await tx
    .select()
    .from(schema.files)
    .where(eq(schema.files.key, key))
    .limit(1);

  return result.length > 0 ? result[0]! : null;
};

export const deleteFile = async (tx: DBLike, id: number): Promise<void> => {
  await tx.delete(schema.files).where(eq(schema.files.id, id));
};

/**
 * Retrieves expired files (DB compares against now()).
 */
export const getExpiredFiles = async (tx: DBLike): Promise<MikuFile[]> => {
  const result = await tx
    .select()
    .from(schema.files)
    .where(
      and(
        isNotNull(schema.files.expiresAt),
        lt(schema.files.expiresAt, sql`now()`),
      ),
    );
  return result;
};

/**
 * Retrieves expired users (DB compares against now()).
 */
export const getExpiredUsers = async (tx: DBLike): Promise<MikuUser[]> => {
  const result = await tx
    .select()
    .from(schema.users)
    .where(
      and(
        isNotNull(schema.users.expiresAt),
        lt(schema.users.expiresAt, sql`now()`),
      ),
    );
  return result;
};

export const init_db = async () => {
  // Create Anonymous user
  await withTransaction(async (tx) => {
    if (await userExists(tx, 'anonymous')) return;

    info('KeyMigrator', 'Creating user Anonymous...');
    const anonymousUser = await createUser(tx, 'anonymous');

    if (anonymousUser)
      info(
        'KeyMigrator',
        `Successfully created user Anonymous with ID #${anonymousUser.id}, key ${anonymousUser.apiKey}`,
      );
  });

  const anonymousUser = await getUser(db, 'anonymous');
  if (!anonymousUser) {
    error('KeyMigrator', 'Failed to create user Anonymous');
    return;
  }

  // Migrate Users from ./keys
  if (await exists('./keys')) {
    const keysFile = await readFile('./keys', 'utf-8');

    if (keysFile) {
      warn('KeyMigrator', 'Keys exists! Migrating keys file to db.');
      const keys = keysFile.split('\n').filter(Boolean);
      if (keys.length <= 0) {
        warn('KeyMigrator', 'There is nothing to do.');
        return;
      }
      for (const key of keys) {
        await withTransaction(async (tx) => {
          if (!(await keyExists(tx, key))) {
            const newUser = key.split('_')[0];
            if (newUser) {
              info('KeyMigrator', `Migrating key ${key} to user ${newUser}`);
              const { user, id } = await createUser(tx, newUser, key);
              if (user) {
                info(
                  'KeyMigrator',
                  `ID #${id} Successfully migrated key ${key} to user ${user}`,
                );
              } else {
                error(
                  'KeyMigrator',
                  `Failed to migrate key ${key} to user ${newUser}`,
                );
              }
            }
          }
        });
      }

      warn('KeyMigrator', `Finished migrating users!`);
    }
  }

  // Migrate File metadata
  if (await exists(UPLOADS_DIR)) {
    const files = await readdir(UPLOADS_DIR);
    if (files.length > 0) {
      warn('FileMigrator', `Migrating files now...`);
    } else {
      warn('FileMigrator', 'There is nothing to do');
    }
    for (const file of files) {
      const ext = extname(file);
      const fileName = basename(file, ext);
      const size = (await stat(path.join(UPLOADS_DIR, file))).size;
      if (fileName.length === 36) continue; // Skip new files
      if (fileName === 'temp') continue; // Temp folder

      await withTransaction(async (tx) => {
        if (!(await getFile(tx, fileName))) {
          info('FileMigrator', `Trying to migrate ${fileName}`);
          const { key } = await addFileWithKey(
            tx,
            anonymousUser.id,
            fileName,
            `${fileName}${ext}`,
            size,
          );

          if (key) {
            info(
              'FileMigrator',
              `Successfully migrated ${fileName} to db, owned by user anonymous ${anonymousUser.id}`,
            );
          }
        }
      });
    }

    warn('FileMigrator', `Finished migrating files!`);
  } else {
    await mkdir(UPLOADS_DIR);
    warn('FileMigrator', `Created uploads directory at ${UPLOADS_DIR}`);
  }

  if (!(await exists(path.join(UPLOADS_DIR, 'temp')))) {
    await mkdir(path.join(UPLOADS_DIR, 'temp'));
    warn(
      'FileMigrator',
      `Created temp directory at ${path.join(UPLOADS_DIR, 'temp')}`,
    );
  }

  info('Database', 'Loaded database module');
};
