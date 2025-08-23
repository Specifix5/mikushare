import { pgTable, text, integer, serial, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  user: text('user').notNull().unique(),
  apiKey: text('api_key').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull(),
});

export const files = pgTable('files', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  ownerId: integer('owner_id')
    .references(() => users.id)
    .notNull(),
  filename: text('filename').notNull(),
  size: integer('size').notNull(),
  realFilename: text('real_filename').notNull().default(''),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull(),
});
