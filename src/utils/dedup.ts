import path from 'path';
import { link } from 'fs/promises';
import { eq, sql } from 'drizzle-orm';
import type { DBLike } from '../db/client';
import { files } from '../db/schema';
import { UPLOADS_DIR } from './constants';

let storageQueue = Promise.resolve();

// Wait before opening a transaction: lock waiters must not occupy all database
// connections while one writer hashes/publishes a large batch.
export const withStorageQueue = async <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = storageQueue;
  let release!: () => void;
  storageQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

// Upload, deletion, and migration share this transaction lock. A source cannot
// disappear while another upload is linking it. One lock avoids batch deadlocks.
export const lockFileStorage = (tx: DBLike) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(719443827)`);

export async function writeDeduplicated(
  tx: DBLike,
  destination: string,
  file: Blob,
  sha256: string,
) {
  const candidates = await tx
    .select()
    .from(files)
    .where(eq(files.sha256, sha256));
  for (const candidate of candidates) {
    const source = path.join(
      UPLOADS_DIR,
      candidate.expiresAt ? 'temp' : '',
      candidate.filename,
    );
    if (source === destination) continue;
    try {
      await link(source, destination);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await Bun.write(destination, file);
}
