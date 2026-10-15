import { randomUUID } from 'crypto';
import { lstat, readdir, statfs } from 'fs/promises';
import path from 'path';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { files, users } from '../db/schema';
import { UPLOADS_DIR } from '../config/constants';
import { removeFile } from '../files/service';

export const cleanupFilter = z
  .strictObject({
    ownerId: z.number().int().positive().optional(),
    olderThanDays: z.number().int().min(1).max(36500).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    (value) => !(value.olderThanDays && (value.from ?? value.to)),
    'Choose an age or a date range',
  )
  .refine(
    (value) =>
      !value.from || !value.to || new Date(value.from) < new Date(value.to),
    'The end must be after the start',
  );

interface SnapshotFile {
  id: number;
  key: string;
  ownerId: number;
}
const previews = new Map<
  string,
  {
    identity: string;
    expiresAt: number;
    files: SnapshotFile[];
  }
>();

export const storageStats = async () => {
  const [totals] = await db
    .select({
      fileCount: sql<number>`count(*)::int`,
      logicalBytes: sql<number>`coalesce(sum(${files.size}), 0)::float8`,
    })
    .from(files);
  const [accounts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  const managed = await db
    .select({ filename: files.filename, expiresAt: files.expiresAt })
    .from(files);
  const present = new Set<string>();
  const inodes = new Set<string>();
  let physicalBytes = 0;
  // Include leftover regular files too, but never follow symlinks outside storage.
  for (const directory of [UPLOADS_DIR, path.join(UPLOADS_DIR, 'temp')]) {
    const entries = await readdir(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const filename = path.join(directory, entry);
      const stat = await lstat(filename, { bigint: true }).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        },
      );
      if (!stat?.isFile()) continue;
      present.add(filename);
      const inode = `${stat.dev}:${stat.ino}`;
      if (inodes.has(inode)) continue;
      inodes.add(inode);
      physicalBytes += Number(stat.size);
    }
  }
  const disk = await statfs(UPLOADS_DIR).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  return {
    accounts: accounts?.count ?? 0,
    ...totals,
    physicalBytes,
    missingFiles: managed.filter(
      (file) =>
        !present.has(
          path.join(UPLOADS_DIR, file.expiresAt ? 'temp' : '', file.filename),
        ),
    ).length,
    storageAvailableBytes: disk ? disk.bavail * disk.bsize : undefined,
  };
};

export const previewCleanup = async (
  identity: string,
  filter: z.infer<typeof cleanupFilter>,
) => {
  const now = Date.now();
  for (const [id, preview] of previews)
    if (preview.expiresAt <= now) previews.delete(id);
  if (previews.size >= 32) return null;
  const predicates = [];
  if (filter.ownerId !== undefined)
    predicates.push(eq(files.ownerId, filter.ownerId));
  if (filter.olderThanDays !== undefined)
    predicates.push(
      lt(files.createdAt, new Date(now - filter.olderThanDays * 86400000)),
    );
  if (filter.from) predicates.push(gte(files.createdAt, new Date(filter.from)));
  if (filter.to) predicates.push(lt(files.createdAt, new Date(filter.to)));
  const selected = await db
    .select({
      id: files.id,
      key: files.key,
      ownerId: files.ownerId,
      name: files.realFilename,
      owner: users.user,
      createdAt: files.createdAt,
      size: files.size,
    })
    .from(files)
    .innerJoin(users, eq(files.ownerId, users.id))
    .where(and(...predicates))
    .orderBy(files.id);
  // Check again after the asynchronous query so concurrent previews cannot bypass the cap.
  if (previews.size >= 32) return null;
  const previewId = randomUUID();
  const expiresAt = now + 5 * 60 * 1000;
  previews.set(previewId, {
    identity,
    expiresAt,
    files: selected.map(({ id, key, ownerId }) => ({ id, key, ownerId })),
  });
  return {
    previewId,
    expiresAt: new Date(expiresAt),
    count: selected.length,
    logicalBytes: selected.reduce((sum, file) => sum + file.size, 0),
    files: selected
      .slice(0, 20)
      .map(({ id, name, owner, createdAt, size }) => ({
        id,
        name,
        owner,
        createdAt,
        size,
      })),
  };
};

export const executeCleanup = async (identity: string, previewId: string) => {
  const preview = previews.get(previewId);
  if (preview?.identity !== identity || preview.expiresAt <= Date.now())
    return null;
  // Consume synchronously before the first await: confirmation is one-shot.
  previews.delete(previewId);
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  for (const file of preview.files) {
    try {
      if (await removeFile(file.id, file)) deleted++;
      else skipped++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed, skipped };
};
