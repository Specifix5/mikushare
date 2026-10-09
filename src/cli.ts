import { env } from './utils/env';
import { createInterface } from 'readline';
import { generateToken } from './utils/tokens';
import { info, warn, error } from './utils/logger';
export { info, warn, error } from './utils/logger';

let databasePromise: Promise<typeof import('./db/client')> | undefined;
const database = () => (databasePromise ??= import('./db/client'));
export const closeCommandDatabase = async () => {
  const loaded = await databasePromise?.catch(() => undefined);
  if (loaded) await loaded.closeDatabase();
};

export const commandNames = (accountsOnly = false) => [
  'help',
  'genkey',
  'getkey',
  'rotatekey',
  'listusers',
  ...(accountsOnly ? [] : ['delfiles']),
  'deluser',
  'admin-token',
  'exit',
];
const help = (accountsOnly: boolean) =>
  console.log(`
Commands:
  genkey <username> [ttl] [key]   Create account; ttl examples: 7d, 24h
  getkey <username>              Show an account's existing access key
  rotatekey <username>           Replace a lost or compromised key
  listusers                      List accounts and expiry dates
${accountsOnly ? '' : '  delfiles <username>             Delete all files owned by an account\n'}\
  deluser <username>              Delete account; transfer files to anonymous
  admin-token                    Generate a separate admin token
  help                           Show this help
  exit                           ${accountsOnly ? 'Close accounts CLI' : 'Shut down'}
Admin access is configured with ADMIN_USERS or ADMIN_TOKENS in .env;
restart after changing them.
`);

export const runCommand = async (
  input: string | string[],
  accountsOnly = false,
) => {
  const [cmd = '', ...args] = Array.isArray(input)
    ? input
    : input.trim().split(/\s+/);
  if (!cmd) return;
  const user = args[0];
  switch (cmd.toLowerCase()) {
    case 'help':
      help(accountsOnly);
      break;
    case 'genkey': {
      if (!user || !/^[a-zA-Z0-9_-]{1,64}$/.test(user))
        throw new Error('Usage: genkey <username> [ttl] [key]');
      const { createUser, getUser, withTransaction } = await database();
      const { parseTime } = await import('./utils/helpers');
      const ttl = args[1];
      const ttlHours = ttl ? parseTime(ttl) : undefined;
      if (
        ttl &&
        (!/^(\d+[dhms])+$/.test(ttl) ||
          !Number.isFinite(ttlHours) ||
          ttlHours! <= 0)
      )
        throw new Error('Use a duration like 7d or 24h');
      const expiresAt =
        ttlHours === undefined
          ? undefined
          : new Date(Date.now() + ttlHours * 3600000);
      if (expiresAt && !Number.isFinite(expiresAt.getTime()))
        throw new Error('Duration is outside the supported date range');
      const result = await withTransaction(async (tx) => {
        if (await getUser(tx, user))
          throw new Error(
            'Account already exists. Use rotatekey to replace its token.',
          );
        return createUser(tx, user, args[2], expiresAt);
      });
      info(
        'Accounts',
        `Created ${user}. Save this token now: ${result.apiKey}`,
      );
      info(
        'Accounts',
        `Expires: ${result.expiresAt?.toISOString() ?? 'never'}`,
      );
      break;
    }
    case 'getkey': {
      if (!user) throw new Error('Usage: getkey <username>');
      const { db, getUser } = await database();
      const account = await getUser(db, user);
      if (!account) throw new Error('Account not found');
      info('Accounts', `Access key for ${user}: ${account.apiKey}`);
      break;
    }
    case 'rotatekey': {
      if (!user) throw new Error('Usage: rotatekey <username>');
      await database();
      const { rotateKey } = await import('./utils/accounts');
      const token = await rotateKey(user);
      if (!token) throw new Error('Account not found');
      info(
        'Accounts',
        `Old token revoked. Save the new token for ${user}: ${token}`,
      );
      break;
    }
    case 'listusers': {
      const { db } = await database();
      const { users } = await import('./db/schema');
      const result = await db
        .select({ id: users.id, user: users.user, expiresAt: users.expiresAt })
        .from(users)
        .orderBy(users.id);
      console.table(
        result.map((account) => ({
          ID: account.id,
          Account: account.user,
          Expires: account.expiresAt?.toISOString() ?? 'never',
          Admin: env.ADMIN_USERS.includes(account.user),
        })),
      );
      break;
    }
    case 'delfiles': {
      if (accountsOnly)
        throw new Error(
          'delfiles requires upload storage. Use the running server CLI to delete files.',
        );
      if (!user) throw new Error('Usage: delfiles <username>');
      const { db, getUser, getFilesByOwner } = await database();
      const { removeFile } = await import('./utils/files');
      const account = await getUser(db, user);
      if (!account) throw new Error('Account not found');
      const files = await getFilesByOwner(db, account.id);
      let count = 0;
      for (const file of files) if (await removeFile(file.id)) count++;
      info('Cleaner', `Deleted ${count} files for ${user}`);
      break;
    }
    case 'deluser': {
      if (!user) throw new Error('Usage: deluser <username>');
      await database();
      const { removeAccount } = await import('./utils/accounts');
      if (!(await removeAccount(user))) throw new Error('Account not found');
      info('Accounts', `Deleted ${user}; files transferred to anonymous`);
      break;
    }
    case 'admin-token': {
      const token = generateToken();
      console.log(`Add this token to ADMIN_TOKENS: ${token}`);
      break;
    }
    case 'exit':
      if (accountsOnly) return 'exit';
      warn('Main', 'Shutting down…');
      process.exit(0);
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. Type help to see commands.`);
  }
};

export const init_cli = () => {
  const commands = commandNames();
  const cli = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY && !!process.stdout.isTTY,
    prompt: 'miku> ',
    completer: (line: string): [string[], string] => [
      commands.filter((cmd) => cmd.startsWith(line)),
      line,
    ],
  });
  info('CLI', 'Type help for commands. Use /adminpane for the admin panel.');
  if (process.stdin.isTTY) cli.prompt();
  let pending = Promise.resolve();
  cli.on('line', (line) => {
    pending = pending.then(async () => {
      try {
        await runCommand(line);
      } catch (err) {
        error('CLI', err instanceof Error ? err.message : 'Command failed');
      }
      if (process.stdin.isTTY) cli.prompt();
    });
  });
};
