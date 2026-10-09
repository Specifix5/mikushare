import { databaseURL } from '../src/utils/env';
import { SQL } from 'bun';

const client = new SQL(databaseURL());

try {
  await client`ALTER TABLE files ADD COLUMN IF NOT EXISTS sha256 text`;
  await client`CREATE INDEX IF NOT EXISTS files_sha256_idx ON files (sha256)`;
  console.log('File checksum column ready. Access tokens are unchanged.');
} finally {
  await client.close();
}
