import { info, warn } from '../cli';
import {
  deleteUserById,
  getExpiredFiles,
  getExpiredUsers,
  getFilesByOwner,
  getUser,
  setFileOwner,
  withTransaction,
} from '../db/client';
import { scheduleHourly } from './helpers';
import { removeFile } from './files';
import { collections } from '../db/schema';
import { eq } from 'drizzle-orm';

export const init_cleanup = () => {
  info('Cleaner', 'Loaded cleaner module');
  scheduleHourly(async () => {
    info('Cleaner', 'Running hourly cleanup job');
    const expiredFiles = await withTransaction(async (tx) => {
      return getExpiredFiles(tx);
    });

    for (const file of expiredFiles) {
      await removeFile(file.id);
      warn('Cleaner', `${file.key} - Deleted expired file ${file.filename}`);
    }

    const expiredUsers = await withTransaction(async (tx) => {
      return getExpiredUsers(tx);
    });

    for (const user of expiredUsers) {
      await withTransaction(async (tx) => {
        const anonymous = await getUser(tx, 'anonymous');
        if (!anonymous) throw new Error('Anonymous account is missing');
        const files = await getFilesByOwner(tx, user.id);
        for (const file of files) {
          info(
            'Cleaner',
            `${user.user} - Migrating ${file.expiresAt ? 'temp ' : ''}file #${file.id} ${file.filename} (${file.key}) to anonymous user`,
          );
          await setFileOwner(tx, file.id, anonymous.id);
        }
        if (user.user === 'anonymous') return;
        await tx
          .update(collections)
          .set({ ownerId: anonymous.id })
          .where(eq(collections.ownerId, user.id));
        await deleteUserById(tx, user.id);
        warn('Cleaner', `${user.user} - Deleted expired user`);
      });
    }

    info('Cleaner', 'Completed hourly cleanup job');
  }, 1000);
};
