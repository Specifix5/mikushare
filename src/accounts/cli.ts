import { createInterface } from 'readline';
import { closeCommandDatabase, commandNames, runCommand } from './commands';
import { error, info } from '../core/logger';

const reportFailure = (failure: unknown) => {
  error(
    'Accounts',
    failure instanceof Error ? failure.message : 'Command failed',
  );
  process.exitCode = 1;
};

async function interactive() {
  const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const cli = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal,
    prompt: 'accounts> ',
    completer: (line: string): [string[], string] => [
      commandNames(true).filter((command) => command.startsWith(line)),
      line,
    ],
  });
  let pending = Promise.resolve();
  let accepting = true;
  let exitRequested = false;
  const close = () => cli.close();
  const done = new Promise<void>((resolve) => {
    cli.once('close', () => {
      accepting = false;
      // readline can reach EOF before queued asynchronous commands finish.
      void pending.then(resolve);
    });
  });
  cli.on('line', (line) => {
    if (!accepting) return;
    pending = pending.then(async () => {
      if (exitRequested) return;
      try {
        if ((await runCommand(line, true)) === 'exit') {
          exitRequested = true;
          close();
        }
      } catch (failure) {
        reportFailure(failure);
      }
      if (terminal && accepting) cli.prompt();
    });
  });
  cli.on('SIGINT', close);
  process.on('SIGINT', close);
  info(
    'Accounts',
    'Type help for commands. This CLI manages PostgreSQL accounts only.',
  );
  if (terminal) cli.prompt();
  await done;
  process.removeListener('SIGINT', close);
}

try {
  const args = process.argv.slice(2);
  if (args.length) await runCommand(args, true);
  else await interactive();
} catch (failure) {
  reportFailure(failure);
} finally {
  try {
    await closeCommandDatabase();
  } catch (failure) {
    reportFailure(failure);
  }
}
