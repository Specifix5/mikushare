import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  user: text('user').notNull().unique(),
  apiKey: text('api_key').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull(),
});

export const files = pgTable(
  'files',
  {
    id: serial('id').primaryKey(),
    key: text('key').notNull().unique(),
    ownerId: integer('owner_id')
      .references(() => users.id)
      .notNull(),
    filename: text('filename').notNull(),
    size: integer('size').notNull(),
    realFilename: text('real_filename').notNull().default(''),
    sha256: text('sha256'),
    pasteTitle: text('paste_title'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('files_sha256_idx').on(table.sha256)],
);

export const collections = pgTable('collections', {
  key: text('key').primaryKey(),
  ownerId: integer('owner_id')
    .references(() => users.id)
    .notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull(),
});

export const collectionFiles = pgTable(
  'collection_files',
  {
    collectionKey: text('collection_key')
      .references(() => collections.key, { onDelete: 'cascade' })
      .notNull(),
    fileId: integer('file_id').references(() => files.id, {
      onDelete: 'set null',
    }),
    fileKey: text('file_key').notNull(),
    name: text('name').notNull(),
    filename: text('filename').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }),
    position: integer('position').notNull(),
  },
  (table) => [primaryKey({ columns: [table.collectionKey, table.fileKey] })],
);
