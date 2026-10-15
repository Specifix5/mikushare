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

### File pages

Opening a file's short link in a browser shows a file page with download,
copyable page link, QR code, upload date, expiry, size, and checksum. Audio has
playback speed controls, embedded artwork/tags, and a seekable waveform when
the browser can decode it. Images show a preview and readable embedded metadata
(including EXIF/GPS, XMP, IPTC, and color profile tags where present). PDFs use
the custom viewer described below; videos use the browser's video player. Other files show the
same information and sharing controls without an inline preview.

Waveforms are generated locally for audio up to 32 MB and 10 minutes. Unsupported
formats and larger files still have normal playback controls when supported by
the browser. Missing or unreadable metadata does not prevent downloading.

`?download=1` always keeps the direct file redirect. Command-line clients and
media requests also keep direct file links; `?view=1` explicitly requests the
file page. Existing crawler image cards and text paste pages are preserved.
Download buttons point to `FILES_URL`. Keep `/file-info/`, `/file-cover/`, and
`/file-preview/` proxied to the app, including when `SHOULD_REDIRECT=true`;
previews support byte ranges and check expiry before serving content.

The file pages share EJS partials in `src/pages/partials/` and browser components
in `src/public/scripts/ui/file-components.js`.

Multi-file uploads always create a collection. The uploader shows a collection name field
only when more than one file is selected; single uploads remain standalone.
Blank collection names become `Unnamed Collection #1`, `#2`, and so on, using a
persistent PostgreSQL sequence so concurrent requests receive distinct numbers.
The sequence is created during startup or by `bun run migrate:collections`.
File links opened from a collection retain a validated `?collection=...` context
and show a clickable `Collection name / File name` heading. Standalone links keep
their ordinary file heading.

To check file pages without a database (isolated storage and database fixtures):

```sh
bun run build
bun test tests/file-view.test.ts tests/pdf.test.ts
```

### PDF viewer

`src/public/scripts/pdf/` contains the PDF.js renderer, worker, SVG annotations,
and vector PDF export. `src/pdf/` contains its template, styles, compressed asset
serving, and build step.
The custom toolbar supports page navigation, selectable text, zoom, fit width,
and fullscreen (with an expanded-page fallback). Controls use the site's
square edges, typography, and colors.

The viewer loads only on PDF pages and renders one page at a time. Its modern
PDF.js engine runs in a worker. JavaScript/CSS are minified, with Brotli/gzip
copies generated at build time. Fonts, character maps, and image decoders load
only when needed. The PDF-writing bundle loads only when exporting. Keep
`/public/pdf/` proxied to the app for compressed asset negotiation; a separate
static server must serve the appropriate `.br`/`.gz` variants itself.

Pen and area-highlight annotations are SVG overlays, with erase, undo, and redo.
They are saved locally in this browser by file checksum. **Save annotated PDF**
adds vector drawing commands to a copy of the original PDF without rasterizing
its pages.
The uploaded original stays unchanged. Encrypted PDFs can be viewed with a
password, but export requires an unencrypted original. The original PDF is
always available through the direct-view link.

### Source layout

Server modules are grouped by purpose. Browser JavaScript lives separately in
`src/public/scripts/`, grouped by feature, with reusable components in `ui/`.
Browser entrypoints are mapped to their public bundle names in
`build-tools/build.ts`. Only compiled bundles are copied into the deployed
`dist/public/`; browser source modules are excluded from the static asset copy.

```text
src/
  accounts/     Account service, tokens, CLI and terminal commands
  admin/        Admin routes, authentication, storage
  collections/  Collection routes, persistence, ZIPs
  config/       Validated environment settings and constants
  core/         Shared HTTP helpers, cleanup, logging and error pages
  db/           Database client and schema
  files/        File routes, pages, metadata, storage
  pages/        Page templates and shared EJS partials
  pdf/          PDF template, styles, asset serving and build
  public/       Browser scripts by feature, static assets and shared styles
  sharing/      QR codes and social embeds
  texts/        Text paste routes, validation
  uploads/      Upload routes, chunks and streaming
```

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
    expires off;
    add_header X-Content-Type-Options nosniff always;
    add_header Content-Security-Policy "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
    etag on;
}

location /_internal/uploads/temp/ {
    internal;
    alias /var/mikushare/uploads/temp/;
    types { } default_type application/octet-stream;
    expires off;
    add_header X-Content-Type-Options nosniff always;
    add_header Content-Security-Policy "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
    etag on;
}
```

After you've setup your nginx configuration, you can make bun let nginx handle file serving by enabling `SHOULD_REDIRECT=true`

Keep public `/uploads/` requests proxied to the app and preserve its cache headers.
In the main site's proxy location, use `proxy_http_version 1.1;` and
`proxy_request_buffering off;` so upload limits can reject streams early.
Purge old cached upload responses from your CDN when deploying these headers.

## Account upload history

Accounts have a `public` boolean, editable in the admin panel when creating an
account or by clicking its public/private control. Public means a shared upload
token: it disables browsing previous uploads. It does not change access to
individual file or collection links. Existing named accounts default to private;
mark shared accounts public in the admin panel. Anonymous always remains public.
The column is added automatically on startup (including account CLI startup).

Changing the token field checks the account after a short typing debounce and
shows `[ prev files ]` only for a valid private token, in both upload modes.
Editing the token immediately hides the button until validation succeeds again. The uploader does not restore saved tokens. The history
lists collections as folders and standalone files, with 50 entries per page.
Grouped files appear inside their collection rather than twice in the root list.
History requests require the current, unexpired bearer token and reject public
accounts on every request. The token is passed to history through this tab's session storage and cleared
when returning to the uploader. Tokens are never placed in history
URLs. File and collection sharing links remain accessible as before.

## meow

read if cute \
mreow ^^
