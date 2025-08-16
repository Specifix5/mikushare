import { unlink } from 'fs/promises';
import path from 'path';
import {
  createUser,
  deleteFile,
  deleteUser,
  getFilesByOwner,
  getUser,
  withTransaction,
} from './db/client';
import { users } from './db/schema';
import { UPLOADS_DIR } from './utils/constants';
import { parseTime } from './utils/helpers';

export const info = (name: string, ...args: unknown[]) => {
  console.log(`${new Date().toISOString()} [${name}]`, ...args);
};

export const warn = (name: string, ...args: unknown[]) => {
  console.warn(`${new Date().toISOString()} [${name}]`, ...args);
};

export const error = (name: string, ...args: unknown[]) => {
  console.error(`${new Date().toISOString()} [${name}]`, ...args);
};

export const init_cli = () => {
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (data) => {
    void (async () => {
      const input = data.toString().trim();
      const cmd = input.split(/\s+/g)[0] ?? '';
      const args = (input.split(/\s+/g) ?? []).slice(1);

      switch (cmd.toLowerCase()) {
        case 'genkey':
          {
            const user = args[0];
            const ttl = args[1];
            const key = args[2];

            if (!user) {
              error('KeyGen', 'Please provide a username');
              return;
            }

            const { apiKey, expiresAt } = await withTransaction(async (tx) => {
              return createUser(
                tx,
                user,
                key,
                ttl
                  ? new Date(Date.now() + parseTime(ttl) * 60 * 60 * 1000)
                  : undefined,
              );
            });

            info('KeyGen', 'Generated key:', apiKey);
            info('KeyGen', 'It will expire on ', expiresAt);
          }
          break;

        case 'getkey':
          {
            const user = args[0];

            if (!user) {
              error('KeyGen', 'Please provide a username');
              return;
            }

            const result = await withTransaction(async (tx) => {
              return getUser(tx, user);
            });

            if (result) {
              info(
                'KeyGen',
                `Showing key for user ${result.user}: ${result.apiKey}`,
              );
            } else {
              error('KeyGen', 'User not found for user ', user);
            }
          }
          break;

        case 'listusers':
          {
            const result = await withTransaction(async (tx) => {
              return tx.select().from(users);
            });

            if (result) {
              info('KeyGen', 'Listing users...');
              result.forEach((user) => {
                info('KeyGen', `#${user.id}: ${user.user}`);
              });
            } else {
              error('KeyGen', "Couldn't fetch user for some reason..");
            }
          }
          break;

        case 'delfiles':
          {
            const user = args[0];

            if (!user) {
              error('KeyGen', 'Please provide a username');
              return;
            }

            await withTransaction(async (tx) => {
              try {
                const userResult = await getUser(tx, user);
                if (!userResult) {
                  error('KeyGen', 'User not found for user ', user);
                  return;
                }
                const files = await getFilesByOwner(tx, userResult.id);

                if (files.length === 0) {
                  info('KeyGen', `No files found for user ${user}`);
                  return;
                }
                let deletedCount = 0;
                for (const file of files) {
                  try {
                    await unlink(
                      path.join(
                        UPLOADS_DIR,
                        file.expiresAt ? './temp/' : './',
                        file.filename,
                      ),
                    );
                  } catch (e) {
                    error(
                      'KeyGen',
                      `Failed to unlink file ${file.filename} (Maybe it doesn't exist?): `,
                      e,
                    );
                  }

                  await deleteFile(tx, file.id);
                  deletedCount++;
                  info(
                    'KeyGen',
                    `Deleted file ${file.filename} (${file.size} bytes) for user ${user}`,
                  );
                }

                warn(
                  'KeyGen',
                  `Successfully deleted ${deletedCount} files for user ${user}`,
                );
              } catch (e) {
                error('KeyGen', `Failed to delete files for user ${user}: `, e);
                throw e;
              }
            });
          }

          break;
        case 'deluser':
          {
            const user = args[0];

            if (!user) {
              error('KeyGen', 'Please provide a username');
              return;
            }

            if (user === 'anonymous') {
              error('KeyGen', 'Cannot delete the anonymous user');
              return;
            }

            await withTransaction(async (tx) => {
              try {
                await deleteUser(tx, user);
                warn('KeyGen', `Successfully deleted user ${user}`);
              } catch (e) {
                error('KeyGen', `Failed to delete user ${user}: `, e);
                throw e;
              }
            });
          }
          break;
        case 'exit':
          warn('Main', 'Shutting down…');
          process.exit(0);
          break;
        default:
          error('cli', 'Unknown command:', cmd);
          break;
      }
    })();
  });
};
