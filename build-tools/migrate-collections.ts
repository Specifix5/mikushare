import { SQL } from 'bun';
import { databaseURL } from '../src/config/env';
const client = new SQL(databaseURL());
try {
  await client.begin(async (tx) => {
    await tx`CREATE SEQUENCE IF NOT EXISTS unnamed_collection_number`;
    await tx`ALTER TABLE files ADD COLUMN IF NOT EXISTS sha256 text`;
    await tx`ALTER TABLE files ADD COLUMN IF NOT EXISTS paste_title text`;
    await tx`CREATE TABLE IF NOT EXISTS collections (
      key text PRIMARY KEY, owner_id integer NOT NULL REFERENCES users(id),
      name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await tx`CREATE TABLE IF NOT EXISTS collection_files (
      collection_key text NOT NULL REFERENCES collections(key) ON DELETE CASCADE,
      file_id integer REFERENCES files(id) ON DELETE SET NULL,
      file_key text NOT NULL, name text NOT NULL, filename text NOT NULL,
      size integer NOT NULL, sha256 text, expires_at timestamptz,
      position integer NOT NULL,
      PRIMARY KEY (collection_key, file_key)
    )`;
    await tx`ALTER TABLE collection_files ADD COLUMN IF NOT EXISTS uploaded_at timestamptz`;
    await tx`UPDATE collection_files AS member SET uploaded_at = source.created_at
      FROM files AS source WHERE member.file_id = source.id AND member.uploaded_at IS NULL`;
  });
  console.log('Collection tables and checksum column ready.');
} finally {
  await client.close();
}
