import { info, warn } from '../cli';
import {
  deleteFile,
  deleteUserById,
  getExpiredFiles,
  getExpiredUsers,
  withTransaction,
} from '../db/client';
import { unlink } from 'fs/promises';
import { UPLOADS_DIR } from './constants';
import path from 'path';
import { scheduleHourly } from './helpers';

export const init_cleanup = () => {
  info('Cleaner', 'Loaded cleaner module');
  scheduleHourly(async () => {
    info('Cleaner', 'Running hourly cleanup job');
    const expiredFiles = await withTransaction(async (tx) => {
      return getExpiredFiles(tx);
    });

    for (const file of expiredFiles) {
      await withTransaction(async (tx) => {
        await unlink(path.join(UPLOADS_DIR, './temp/', file.filename));
        await deleteFile(tx, file.id);
        warn('Cleaner', `${file.key} - Deleted expired file ${file.filename}`);
      });
    }

    const expiredUsers = await withTransaction(async (tx) => {
      return getExpiredUsers(tx);
    });

    for (const user of expiredUsers) {
      await withTransaction(async (tx) => {
        await deleteUserById(tx, user.id);
        warn('Cleaner', `${user.user} - Deleted expired user`);
      });
    }

    info('Cleaner', 'Completed hourly cleanup job');
  }, 1000);
};
