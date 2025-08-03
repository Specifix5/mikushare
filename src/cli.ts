import { createUser, getUser, withTransaction } from './db/client';
import { users } from './db/schema';

export const info = (name: string, ...string: any) => {
  console.log(`${new Date().toISOString()} [${name}]`, ...string);
};

export const warn = (name: string, ...string: any) => {
  console.warn(`${new Date().toISOString()} [${name}]`, ...string);
};

export const error = (name: string, ...string: any) => {
  console.error(`${new Date().toISOString()} [${name}]`, ...string);
};

export const init_cli = () => {
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (data) => {
    const input = data.toString().trim();
    const cmd = input.split(/\s+/g)[0] || '';

    switch (cmd.toLowerCase()) {
      case 'genkey':
        {
          const user = input.slice(cmd.length + 1);

          const { apiKey } = await withTransaction(async (tx) => {
            return await createUser(tx, user);
          });

          info('KeyGen', 'Generated key:', apiKey);
        }
        break;

      case 'getkey':
        {
          const user = input.slice(cmd.length + 1);

          const result = await withTransaction(async (tx) => {
            return await getUser(tx, user);
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
            return await tx.select().from(users);
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
      case 'exit':
        {
          warn('Main', 'Shutting down…');
          process.exit(0);
        }
        break;
      default:
        error('cli', 'Unknown command:', cmd);
        break;
    }
  });
};
