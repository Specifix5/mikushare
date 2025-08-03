import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Users table = uploaders
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user: text('user').notNull().unique(),
  apiKey: text('api_key').notNull().unique(),

  /// Nullable expiry for API key
  expiresAt: text('expires_at').default(sql`NULL`),

  createdAt: text('created_at')
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .notNull(),
});

// Files table = uploaded files
export const files = sqliteTable('files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),

  ownerId: integer('owner_id')
    .references(() => users.id)
    .notNull(),

  filename: text('filename').notNull(),
  size: integer('size').notNull(),

  /// Expiry: NULL = permanent
  expiresAt: text('expires_at').default(sql`NULL`),

  createdAt: text('created_at')
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .notNull(),
});
