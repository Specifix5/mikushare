# miku share/sankyuu

To install dependencies:

```bash
bun install
```

## Setting up .env

Take a look at `.env.example` in the root folder of the project.
Those are all the available environment variables you can use

This project can run as is or you can (and should) let nginx (or any other proxy servers)
serve the files for you.

If you're pointing the `UPLOADS_DIRECTORY` to something like `/var/www/`
make sure you have `chmod` the folder accordingly to allow bun to read and write, otherwise it will get
a permission denied error.

### IMPORTANT Note

- If you don't use any web servers that serves on a seperate path (e.g /uploads/), **proper OpenGraph embedding is not supported as bun will serve the file directly from shortlinks**
- It is recommended that if you are setting this up with a web server like nginx, you should add seperate location blocks for `/uploads/` and `/uploads/temp/`, so you can control the cache control headers seperately (e.g temp files get 1 hour TTL, etc.)

## Before you run the project

If you haven't already, set up the database by running

```
bunx drizzle-kit generate
bunx drizzle-kit push
```

This will create an sqlite database with the schema
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
