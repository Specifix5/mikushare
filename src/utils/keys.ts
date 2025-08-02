import { existsSync, readFileSync, writeFileSync } from 'fs';
import { exists, readFile } from 'fs/promises';

export const AddToKeylist = (key: string) => {
  let keyList = '';

  if (existsSync('./keys')) {
    keyList = readFileSync('./keys', 'utf-8').toString();
  }
  keyList += `${key}\n`;

  writeFileSync('./keys', keyList);
};

export const GenerateKey = (user: string): string => {
  const randomBytes = require('crypto').randomBytes;
  const key = randomBytes(16).toString('hex');
  const generatedKey = `${user}_${key}`;

  return generatedKey;
};

export const CheckIfKeyValid = async (key: string): Promise<boolean> => {
  if (!(await exists('./keys'))) return false;

  const keyList = (await readFile('./keys', 'utf-8')).toString().split('\n');
  return keyList.includes(key);
};
