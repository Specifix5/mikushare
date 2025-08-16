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
 * Represents a function that executes a given function within a database transaction.
 *
 * @template T - The type of the result returned by the function.
 * @param {(tx: DBLike) => Promise<T>} fn - The function to execute within the transaction.
 * @returns {Promise<T>} - A promise that resolves to the result of the function.
 */
export async function withTransaction<T>(
  fn: (tx: DBLike) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

/**
 * Creates a new user in the database.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {string} user - The username of the user.
 * @param {string} [key] - The API key of the user. If not provided, a random API key is generated.
 * @param {Date} [expiryDate] - The expiry date of the user's API key. If not provided, the API key never expires.
 * @returns {Promise<MikuUser>} - A Promise that resolves to the inserted user.
 * @throws {FailedToInsertUserError} - If the user failed to be inserted into the database.
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
      expiresAt: expiryDate ?? null,
    })
    .returning();

  // Throw an error if the user failed to be inserted
  if (!insertedUser) throw new FailedToInsertUserError();

  return insertedUser;
};

/**
 * Retrieves a user from the database using their API key.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {string} key - The API key of the user.
 * @returns {Promise<MikuUser | null>} - A Promise that resolves to the user object if found, or null if not found.
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
 * Retrieves a user from the database using their username.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {string} user - The username of the user.
 * @returns {Promise<MikuUser | null>} - A Promise that resolves to the user object if found, or null if not found.
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
 * Check if a user exists in the database, and if the user's API key is not expired.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {string} user - The username of the user.
 * @returns {Promise<boolean>} - A Promise that resolves to a boolean indicating if the user exists and is not expired.
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
 * Delete a user from the database.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {string} user - The username of the user to delete.
 * @returns {Promise<void>} - A Promise that resolves when the user is deleted.
 */
export const deleteUser = async (tx: DBLike, user: string): Promise<void> => {
  await tx.delete(schema.users).where(eq(schema.users.user, user));
};

export const deleteUserById = async (tx: DBLike, id: number): Promise<void> => {
  await tx.delete(schema.users).where(eq(schema.users.id, id));
};

/**
 * Check if a key exists in the database, and if the associated user's API key is not expired.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {string} key - The API key to check.
 * @returns {Promise<boolean>} - A Promise that resolves to a boolean indicating if the key exists and is not expired.
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
 * Inserts a new file entry into the database with a given key.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {number} ownerId - The ID of the user who owns the file.
 * @param {string} key - The API key associated with the file.
 * @param {string} filename - The name of the file.
 * @param {number} size - The size of the file in bytes.
 * @param {Date} [expiryDate] - The expiry date of the file. If not provided, the file never expires.
 * @returns {Promise<{ key: string; filename: string }>} - A Promise that resolves to an object with the key and filename of the inserted file.
 * @throws {KeyCollisionError} - If the key already exists in the database.
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
      expiresAt: expiryDate ?? null,
    });
  } catch (e) {
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
 * Inserts a new file entry into the database with a random key.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {number} ownerId - The ID of the user who owns the file.
 * @param {string} extname - The file extension of the file.
 * @param {number} size - The size of the file in bytes.
 * @param {Date} [expiryDate] - The expiry date of the file. If not provided, the file never expires.
 * @returns {Promise<{ key: string; filename: string }>} - A Promise that resolves to an object with the key and filename of the inserted file.
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
 * Retrieves a file from the database by its key.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {string} key - The key of the file to retrieve.
 * @returns {Promise<MikuFile | null>} - A Promise that resolves to the file object with the given key, or null if it does not exist.
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
 * Retrieves files that have expired from the database.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @returns {Promise<MikuFile[]>} - A Promise that resolves to an array of expired file objects.
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
 * Retrieves files from the database that belong to a specific user.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {number} ownerId - The ID of the user whose files to retrieve.
 * @returns {Promise<MikuFile[]>} - A Promise that resolves to an array of file objects belonging to the user.
 */
export const getFilesByOwner = async (
  tx: DBLike,
  ownerId: number,
): Promise<MikuFile[]> => {
  const result = await tx
    .select()
    .from(schema.files)
    .where(eq(schema.files.ownerId, ownerId));

  return result;
};

/**
 * Updates the owner of a file in the database.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @param {number} fileId - The ID of the file to update.
 * @param {number} newOwnerId - The ID of the new owner.
 * @return {Promise<void>} A Promise that resolves when the update is complete.
 */
export const setFileOwner = async (
  tx: DBLike,
  fileId: number,
  newOwnerId: number,
): Promise<void> => {
  await tx
    .update(schema.files)
    .set({ ownerId: newOwnerId })
    .where(eq(schema.files.id, fileId));
};

/**
 * Retrieves users from the database that have expired.
 *
 * @param {DBLike} tx - The database transaction to use.
 * @returns {Promise<MikuUser[]>} - A Promise that resolves to an array of expired user objects.
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
