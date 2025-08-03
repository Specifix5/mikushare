import { existsSync, readFileSync, writeFileSync } from 'fs';
import { exists, readFile } from 'fs/promises';
import { keyExists, userExists, withTransaction } from '../db/client';

export const toISO = (date?: Date | null) => (date ? date.toISOString() : null);

export const CheckIfKeyValid = async (key: string): Promise<boolean> => {
  return await withTransaction(async (tx) => {
    return await keyExists(tx, key);
  });
};
