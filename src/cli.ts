import { createUser, deleteUser, getUser, withTransaction } from './db/client';
import { users } from './db/schema';
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

            if (!user) {
              error('KeyGen', 'Please provide a username');
              return;
            }

            const { apiKey } = await withTransaction(async (tx) => {
              return createUser(
                tx,
                user,
                undefined,
                ttl
                  ? new Date(Date.now() + parseTime(ttl) * 60 * 60 * 1000)
                  : undefined,
              );
            });

            info('KeyGen', 'Generated key:', apiKey);
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
        case 'deluser':
          {
            const user = args[0];

            if (!user) {
              error('KeyGen', 'Please provide a username');
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
