import path from 'path';
import { randomUUID } from 'crypto';
import { link, readdir, rename, stat, unlink } from 'fs/promises';
import { eq } from 'drizzle-orm';
import { db, withTransaction } from '../src/db/client';
import { files } from '../src/db/schema';
import { UPLOADS_DIR } from '../src/utils/constants';
import { hashFile } from '../src/utils/hashing';
import { lockFileStorage } from '../src/utils/dedup';

// Scan both managed locations, including legacy files without database rows.
// Other directories (ZIP caches, etc.) are intentionally outside this migration.
try {
  const report = await withTransaction(async (tx) => {
    await lockFileStorage(tx);
    const metadata = new Map(
      (await tx.select().from(files)).map((file) => [
        path.join(UPLOADS_DIR, file.expiresAt ? 'temp' : '', file.filename),
        file,
      ]),
    );
    const hashes = new Map<string, string>();
    const physicalHashes = new Map<string, string>();
    let scanned = 0;
    let combined = 0;
    let savedBytes = 0;
    for (const directory of [UPLOADS_DIR, path.join(UPLOADS_DIR, 'temp')]) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || /\.(deleted|dedup)-/.test(entry.name)) continue;
        const filename = path.join(directory, entry.name);
        const current = await stat(filename);
        const inode = `${current.dev}:${current.ino}`;
        const sha256 =
          physicalHashes.get(inode) ?? (await hashFile(Bun.file(filename)));
        physicalHashes.set(inode, sha256);
        scanned++;
        const source = hashes.get(sha256);
        if (source) {
          const original = await stat(source);
          if (current.dev !== original.dev || current.ino !== original.ino) {
            const staging = filename + '.dedup-' + randomUUID();
            try {
              await link(source, staging);
              // Atomic replacement: the original is retained if linking fails.
              await rename(staging, filename);
            } finally {
              await unlink(staging).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
              });
            }
            combined++;
            if (current.nlink === 1) savedBytes += current.size;
          }
        } else hashes.set(sha256, filename);
        const row = metadata.get(filename);
        if (row && row.sha256 !== sha256)
          await tx.update(files).set({ sha256 }).where(eq(files.id, row.id));
      }
    }
    return { scanned, uniqueHashes: hashes.size, combined, savedBytes };
  });
  console.log('Deduplication complete:', report);
} finally {
  await db.$client.close();
}
