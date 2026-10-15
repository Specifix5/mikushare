import { databaseURL } from '../src/config/env';
import { Database } from 'bun:sqlite';
import { drizzle as drizzlePg } from 'drizzle-orm/bun-sql';
import { SQL } from 'bun';
import * as schema from '../src/db/schema';

const sqlite = new Database('database.db', { readonly: true });

const client = new SQL(databaseURL());
await client`SET TIME ZONE 'UTC'`;
const pg = drizzlePg({ client, schema });

const toDate = (v: string | null) => (v ? new Date(v) : null);

async function migrateUsers() {
  const rows = sqlite
    .query(
      `SELECT id, user, api_key AS apiKey, expires_at AS expiresAt, created_at AS createdAt FROM users`,
    )
    .all() as {
    id: number;
    user: string;
    apiKey: string;
    expiresAt: string | null;
    createdAt: string;
  }[];

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await pg.transaction(async (tx) => {
      for (const r of chunk) {
        await tx
          .insert(schema.users)
          .values({
            id: r.id,
            user: r.user,
            apiKey: r.apiKey,
            expiresAt: toDate(r.expiresAt),
            createdAt: toDate(r.createdAt) ?? new Date(),
          })
          .onConflictDoNothing();
      }
    });
  }

  await client`
    SELECT setval(pg_get_serial_sequence('users','id'),
                  (SELECT COALESCE(MAX(id),0) FROM users), true)
  `;
}

async function migrateFiles() {
  const rows = sqlite
    .query(
      `SELECT id, key, owner_id AS ownerId, filename, size, expires_at AS expiresAt, created_at AS createdAt FROM files`,
    )
    .all() as {
    id: number;
    key: string;
    ownerId: number;
    filename: string;
    size: number;
    expiresAt: string | null;
    createdAt: string;
  }[];

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await pg.transaction(async (tx) => {
      for (const r of chunk) {
        await tx
          .insert(schema.files)
          .values({
            id: r.id,
            key: r.key,
            ownerId: r.ownerId,
            filename: r.filename,
            size: r.size,
            expiresAt: toDate(r.expiresAt),
            createdAt: toDate(r.createdAt) ?? new Date(),
          })
          .onConflictDoNothing();
      }
    });
  }

  await client`
    SELECT setval(pg_get_serial_sequence('files','id'),
                  (SELECT COALESCE(MAX(id),0) FROM files), true)
  `;
}

async function main() {
  await migrateUsers();
  await migrateFiles();

  const [users] = await client<
    { count: number }[]
  >`SELECT COUNT(*)::int AS count FROM users`;
  const [files] = await client<
    { count: number }[]
  >`SELECT COUNT(*)::int AS count FROM files`;
  console.log(`Users: ${users?.count}, Files: ${files?.count}`);

  await client.end();
  sqlite.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
