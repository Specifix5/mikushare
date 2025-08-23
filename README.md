# miku share/sankyuu

To install dependencies:

```bash
bun install
```

## Setting up .env

Take a look at `.env.example` in the root folder of the project.
Those are all the available environment variables you can use

This project can run as is or you can (and should) [let nginx (or any other proxy servers)](#using-a-web-server-like-nginx)
serve the files for you.

If you're pointing the `UPLOADS_DIRECTORY` to something like `/var/mikushare`
make sure you have `chmod` the folder accordingly to allow bun to read and write, otherwise it will get
a permission denied error.

> [!IMPORTANT]
>
> It is recommended that if you are setting this up [with a web server like nginx](#using-a-web-server-like-nginx), you should add seperate location blocks for `/uploads/` and `/uploads/temp/`, so you can control the cache control headers seperately (e.g temp files get 1 hour TTL, etc.)

## Before you run the project

If you haven't already, set up the database by running

```sh
# Deploy Postgres from docker
docker compose up -d

# Prepare Postgres
bunx drizzle-kit generate
bunx drizzle-kit migrate
```

This will prepare PostgreSQL with the schema
So mikushare can run, otherwise you'll get an error.

Build the project with

```
bun run build
bun run start
```

or run

```
bun run dev
```

to combine the two commands into one for fast dev debugging.

### Migrating from SQLite

If you've previously used sqlite before, you can run the migration script

```sh
# Run after docker compose and drizzle-kit migrate
bun run ./build-tools/migrate-sqlite-to-pg.ts
```

## Using a web server (like nginx)

If you ever decide to use a web server to serve your files, here is a config example for nginx, \
Make sure the folders below have already been created:

```nginx
# Inside your server block

location /_internal/uploads/ {
    internal;
    alias /var/mikushare/uploads/;
    types { } default_type application/octet-stream;
    etag on;
}

location /_internal/uploads/temp/ {
    internal;
    alias /var/mikushare/uploads/temp/;
    types { } default_type application/octet-stream;
    etag on;
}
```

After you've setup your nginx configuration, you can make bun let nginx handle file serving by enabling `SHOULD_REDIRECT=true`

## meow

read if cute \
mreow ^^
