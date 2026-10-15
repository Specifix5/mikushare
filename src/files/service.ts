import path from 'path';
import { rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { deleteFile, withTransaction } from '../db/client';
import { files } from '../db/schema';
import { eq } from 'drizzle-orm';
import { UPLOADS_DIR } from '../config/constants';
import { warn } from '../accounts/commands';
import { lockFileStorage, withStorageQueue } from './dedup';

export const removeFile = async (
  id: number,
  expected?: { key: string; ownerId: number },
): Promise<boolean> =>
  withStorageQueue(async () => {
    let filepath = '';
    let quarantine = '';
    let moved = false;
    try {
      const removed = await withTransaction(async (tx) => {
        await lockFileStorage(tx);
        const [file] = await tx
          .select()
          .from(files)
          .where(eq(files.id, id))
          .for('update');
        if (!file) return false;
        if (
          expected &&
          (file.key !== expected.key || file.ownerId !== expected.ownerId)
        )
          return false;
        filepath = path.join(
          UPLOADS_DIR,
          file.expiresAt ? 'temp' : '',
          file.filename,
        );
        quarantine = filepath + '.deleted-' + randomUUID();
        try {
          await rename(filepath, quarantine);
          moved = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        await deleteFile(tx, id);
        return true;
      });
      if (!removed) return false;
    } catch (err) {
      if (moved) await rename(quarantine, filepath);
      throw err;
    }
    if (moved) {
      try {
        await unlink(quarantine);
      } catch {
        warn('Cleaner', `Remove leftover quarantined file: ${quarantine}`);
      }
    }
    return true;
  });
