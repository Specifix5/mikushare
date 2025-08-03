# miku share

To install dependencies:

```bash
bun install
```

## Setting up .env

Take a look at `.env.example` in the root folder of the project.
Those are all the available environment variables you can use

This project can run as is or you can (and should) let nginx
serve the files for you.

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
