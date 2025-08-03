import { drizzle } from 'drizzle-orm/bun-sqlite';
import Database from 'bun:sqlite';
import type RunResult from 'bun:sqlite';

import { randomBytes, randomUUID } from 'crypto';

import * as schema from './schema';
import type { SQLiteTransaction } from 'drizzle-orm/sqlite-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { files, users } from './schema';
import { toISO } from '../utils/keys';
import { readFile } from 'fs/promises';
import { error, info, warn } from '../cli';
import { FailedToInsertUserError, KeyCollisionError } from './errors';
import { readdir } from 'fs/promises';
import { UPLOADS_DIR } from '../utils/constants';
import path, { basename, extname } from 'path';
import { stat } from 'fs/promises';

// init sqlite
const sqlite = new Database('database.db');
export const db = drizzle(sqlite, { schema });
export type DBLike =
  | typeof db
  | SQLiteTransaction<
      'sync',
      RunResult,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >
  | SQLiteTransaction<
      'sync',
      void,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export type MikuUser = {
  id: number;
  user: string;
  apiKey: string;
  expiresAt: string | null;
  createdAt: string;
};

export type MikuFile = {
  id: number;
  key: string;
  ownerId: number;
  filename: string;
  size: number;
  expiresAt: string | null;
  createdAt: string;
};

/**
 * Executes a given function within a database transaction.
 * Automatically rolls back the transaction if an error occurs.
 *
 * @param fn - The function that contains database operations to be executed within the transaction.
 * @returns The result of the function execution.
 * @template T The type of the result returned by the function.
 */
export async function withTransaction<T>(
  fn: (
    tx: SQLiteTransaction<
      'sync',
      void,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >,
  ) => Promise<T>,
): Promise<T> {
  // Begin a new transaction
  return db.transaction(async (tx) => {
    return await fn(tx);
  });
}

/**
 * Insert a new user with API key
 *
 * If the key is not provided, a random key is generated.
 * If the expiryDate is not provided, the key is set to never expire.
 *
 * @param tx - The transaction
 * @param user - The user to insert
 * @param key - The API key to use
 * @param expiryDate - The date when the key expires
 * @returns The inserted user
 */
export const createUser = async (
  tx: DBLike,
  user: string,
  key?: string,
  expiryDate?: Date,
): Promise<MikuUser> => {
  const apiKey = key ?? `${user}_${randomBytes(16).toString('hex')}`;

  const [insertedUser] = await tx
    .insert(users)
    .values({
      user,
      apiKey,
      expiresAt: expiryDate ? toISO(expiryDate) : null,
    })
    .returning();

  if (!insertedUser) {
    throw new FailedToInsertUserError();
  }

  return {
    id: insertedUser.id,
    user,
    apiKey: insertedUser.apiKey,
    createdAt: insertedUser.createdAt,
    expiresAt: insertedUser.expiresAt,
  };
};

/**
 * Gets the user data
 *
 * @param tx - The transaction
 * @param user - The user to check
 * @returns The user
 */
export const getUserFromKey = async (
  tx: DBLike,
  key: string,
): Promise<MikuUser | null> => {
  const result = await tx
    .select()
    .from(users)
    .where(eq(users.apiKey, key))
    .limit(1);
  return result[0] ?? null;
};

/**
 * Gets the user data
 *
 * @param tx - The transaction
 * @param user - The user to check
 * @returns The user
 */
export const getUser = async (
  tx: DBLike,
  user: string,
): Promise<MikuUser | null> => {
  const result = await tx
    .select()
    .from(users)
    .where(eq(users.user, user))
    .limit(1);
  return result[0] ?? null;
};

/**
 * Check if a user exists and their key is not expired
 *
 * @param tx - The transaction
 * @param user - The user to check
 * @returns Whether the user exists and their key is not expired
 */
export const userExists = async (
  tx: DBLike,
  user: string,
): Promise<boolean> => {
  const result = await tx
    .select()
    .from(users)
    .where(eq(users.user, user))
    .limit(1);

  if (result.length === 0) return false;

  const u = result[0]!;

  // Check if the key is expired
  if (u.expiresAt && new Date(u.expiresAt) < new Date()) {
    await tx.delete(users).where(eq(users.id, u.id));
    return false;
  }

  return true;
};

/**
 * Check if key exists and is not expired
 *
 * @param tx - The transaction
 * @param key - The API key to check
 * @returns Whether the key exists and is not expired
 */
export const keyExists = async (tx: DBLike, key: string): Promise<boolean> => {
  const result = await tx
    .select()
    .from(users)
    .where(eq(users.apiKey, key))
    .limit(1);

  if (result.length === 0) return false;

  const u = result[0]!;

  if (u.expiresAt && new Date(u.expiresAt) < new Date()) {
    await tx.delete(users).where(eq(users.id, u.id));
    return false;
  }

  return true;
};

/**
 * Insert the file into the database
 *
 * @param {DBLike} tx - The transaction
 * @param {number} ownerId - The owner of the file
 * @param {string} key - The API key for the file
 * @param {string} filename - The filename for the file
 * @param {number} size - The size of the file in bytes
 * @param {Date} [expiryDate] - The date when the file should expire
 *
 * @returns {Promise<{ key: string; filename: string }>} The inserted key and filename
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
    await tx.insert(files).values({
      key,
      ownerId,
      filename,
      size,
      expiresAt: toISO(expiryDate),
    });
  } catch (e: any) {
    if (e.message.includes('UNIQUE')) {
      throw new KeyCollisionError();
    }
    throw e;
  }

  return { key, filename };
};

/**
 * Inserts a new file entry into the database.
 *
 * @param {DBLike} tx - The transaction object used for the database operation.
 * @param {number} ownerId - The ID of the user who owns the file.
 * @param {string} extname - The file extension (e.g., .png, .jpg).
 * @param {number} size - The size of the file in bytes.
 * @param {Date} [expiryDate] - Optional expiration date for the file.
 *
 * @returns {Promise<{ key: string; filename: string }>} A promise that resolves to the key and filename of the newly inserted file.
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
 *
 * @param {DBLike} tx - The transaction object used for the database operation.
 * @param {string} key - The API key associated with the file.
 *
 * @returns {Promise<MikuFile | null>} A promise that resolves to the file metadata or null if the file does not exist.
 */
export const getFile = async (
  tx: DBLike,
  key: string,
): Promise<MikuFile | null> => {
  const result = await tx
    .select()
    .from(files)
    .where(eq(files.key, key))
    .limit(1);

  // If the query returned a result, return the file metadata.
  // Otherwise, return null to indicate that the file does not exist.
  return result.length > 0 ? result[0]! : null;
};

export const init_db = async () => {
  // Create Anonymous user
  await withTransaction(async (tx) => {
    if (await userExists(tx, 'anonymous')) return;

    info('KeyMigrator', 'Creating user Anonymous...');
    let anonymousUser = await createUser(tx, 'anonymous');

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

  // Migrate Users
  const keysFile = await readFile('./keys', 'utf-8');

  if (keysFile) {
    warn('KeyMigrator', 'Keys exists! Migrating keys file to db.');
    const keys = keysFile.split('\n');
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

  // Migrate File metadata
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
};
