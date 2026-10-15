import { SQL } from 'bun';
import { databaseURL } from '../src/config/env';

const client = new SQL(databaseURL());
try {
  await client`ALTER TABLE files ADD COLUMN IF NOT EXISTS paste_title text`;
  console.log('Text paste metadata column ready.');
} finally {
  await client.close();
}
