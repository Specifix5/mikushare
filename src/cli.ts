import { randomBytes } from 'crypto';
import { AddToKeylist, GenerateKey } from './utils/keys';
export const init_cli = () => {
  // CLI loop
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (data) => {
    const input = data.toString().trim();
    const cmd = input.split(/\s+/g)[0] || '';

    switch (cmd.toLowerCase()) {
      case 'genkey':
        const user = input.slice(7);

        const generatedKey = GenerateKey(user);
        AddToKeylist(generatedKey);

        console.log('Generated key:', generatedKey);
        break;
      case 'exit':
        console.log('Shutting down…');
        process.exit(0);
        break;
      default:
        console.log('Unknown command:', cmd);
        break;
    }
  });
};
