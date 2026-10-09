import { randomBytes, createHash } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type DBLike } from '../db/client';
import { collections, collectionFiles, files } from '../db/schema';
import { BASE_URL, MAX_UPLOAD_FILES, UPLOADS_DIR } from './constants';
import { normalizeFilename, uniqueFilenames } from './filenames';
import path from 'path';
import { isStoredFile } from './stored-files';

export const addCollection = async (
  tx: DBLike,
  ownerId: number,
  keys: string[],
  name: string,
) => {
  const unique = [...new Set(keys)];
  if (!unique.length || unique.length > MAX_UPLOAD_FILES)
    throw new Error('Invalid collection size');
  const rows = await tx
    .select()
    .from(files)
    .where(and(eq(files.ownerId, ownerId), inArray(files.key, unique)));
  if (
    rows.length !== unique.length ||
    rows.some((file) => file.expiresAt && file.expiresAt <= new Date())
  ) {
    throw new Error('Only your own available files can be grouped');
  }
  const members = unique.map((key) => rows.find((file) => file.key === key)!);
  const key = randomBytes(12).toString('base64url');
  const safeName = normalizeFilename(name, 'collection');
  const names = uniqueFilenames(
    members.map((file) => file.realFilename || file.filename),
  );
  await tx.insert(collections).values({ key, name: safeName, ownerId });
  // Snapshot names and membership once; deletion only marks a source unavailable.
  await tx.insert(collectionFiles).values(
    members.map((file, position) => ({
      collectionKey: key,
      fileId: file.id,
      fileKey: file.key,
      name: names[position]!,
      filename: file.filename,
      size: file.size,
      sha256: file.sha256,
      expiresAt: file.expiresAt,
      uploadedAt: file.createdAt,
      position,
    })),
  );
  return { key, name: safeName, url: `${BASE_URL}/collections/${key}` };
};

export const readCollection = async (key: string) => {
  const [collection] = await db
    .select()
    .from(collections)
    .where(eq(collections.key, key));
  if (!collection) return null;
  const rows = await db
    .select()
    .from(collectionFiles)
    .where(eq(collectionFiles.collectionKey, key))
    .orderBy(collectionFiles.position);
  const members = [];
  for (const file of rows) {
    const filepath = path.join(
      UPLOADS_DIR,
      file.expiresAt ? 'temp' : '',
      file.filename,
    );
    const available =
      file.fileId !== null &&
      (!file.expiresAt || file.expiresAt > new Date()) &&
      (await isStoredFile(filepath));
    members.push({ ...file, key: file.fileKey, filepath, available });
  }
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        name: collection.name,
        members: members
          .filter((file) => file.available)
          .map((file) => [
            file.key,
            file.name,
            file.sha256,
            file.size,
            file.expiresAt,
          ]),
      }),
    )
    .digest('hex');
  return { ...collection, members, revision };
};

export type Collection = NonNullable<
  Awaited<ReturnType<typeof readCollection>>
>;
