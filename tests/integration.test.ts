import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  unlink,
  stat,
} from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { hashFile } from '../src/utils/hashing';
import { normalizeFilename, contentDisposition } from '../src/utils/filenames';
import { unzipSync, strFromU8 } from 'fflate';

// Never run destructive fixtures against the configured application database.
if (
  process.env.MIKU_TEST_DATABASE !== '1' ||
  process.env.DB_NAME !== 'miku_test'
) {
  throw new Error(
    'Use a disposable miku_test database and MIKU_TEST_DATABASE=1',
  );
}

const dedicatedToken = 'test-dedicated-admin-token';
const otherAdminToken = 'test-other-dedicated-admin-token';
process.env.ADMIN_USERS = 'owner';
process.env.ADMIN_TOKENS = `${dedicatedToken},${otherAdminToken}`;
process.env.MAX_FILE_SIZE = '0.001';
process.env.MAX_TEMP_FILE_SIZE = '0.002';
process.env.MAX_BATCH_FILE_SIZE = '0.003';
process.env.SHOULD_REDIRECT = 'false';
process.env.ZIP_CACHE_TTL_SECONDS = '120';
let uploadDir: string;
let app: ReturnType<typeof import('../src/app').createApp>;
let client: SQL;
let base: string;

const request = (route: string, options: RequestInit = {}) =>
  fetch(base + route, { ...options, redirect: 'manual' });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const upload = (token: string, files: File[], ttl?: string) => {
  const body = new FormData();
  files.forEach((file) => body.append('file', file));
  if (ttl !== undefined) body.append('ttl', ttl);
  return request('/upload', { method: 'POST', headers: bearer(token), body });
};
const adminJson = (route: string, body: unknown, token = dedicatedToken) =>
  request('/adminpane/api/files/' + route, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const accountsCLI = (
  args: string[] = [],
  input?: string,
  environment: Record<string, string | undefined> = {},
) =>
  Bun.spawnSync(['bun', 'run', 'accounts', ...args], {
    env: {
      ...process.env,
      UPLOADS_DIRECTORY: path.join(
        uploadDir,
        'accounts-must-not-create-storage',
      ),
      PORT: String(app.server?.port ?? 0),
      ...environment,
    },
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
const imageFixture = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
const metaContent = (html: string, property: string): string | undefined => {
  const tag = html.match(
    new RegExp(`<meta\\s+[^>]*(?:property|name)="${property}"[^>]*>`, 'i'),
  )?.[0];
  return tag
    ?.match(/content="([^"]*)"/)?.[1]
    ?.replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
};
const migrate = () => {
  const result = Bun.spawnSync(
    ['bun', 'run', 'build-tools/migrate-checksums.ts'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), 'miku-integration-'));
  process.env.UPLOADS_DIRECTORY = uploadDir;
  process.env.ZIP_CACHE_DIRECTORY = path.join(uploadDir, 'zip-cache');
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  client = new SQL(
    `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`,
  );
  await client`DROP TABLE IF EXISTS collection_files`;
  await client`DROP TABLE IF EXISTS collections`;
  await client`DROP TABLE IF EXISTS files`;
  await client`DROP TABLE IF EXISTS users`;
  await client`CREATE TABLE users (
    id serial PRIMARY KEY, "user" text NOT NULL UNIQUE, api_key text NOT NULL UNIQUE,
    expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await client`CREATE TABLE files (
    id serial PRIMARY KEY, key text NOT NULL UNIQUE, owner_id integer NOT NULL REFERENCES users(id),
    filename text NOT NULL, size integer NOT NULL, real_filename text NOT NULL DEFAULT '',
    expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await client`INSERT INTO users ("user", api_key) VALUES ('legacy', 'legacy-access-token')`;
  migrate();
  migrate();
  const collectionMigration = Bun.spawnSync(
    ['bun', 'run', 'build-tools/migrate-collections.ts'],
    { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
  );
  if (collectionMigration.exitCode !== 0)
    throw new Error(collectionMigration.stderr.toString());
  const database = await import('../src/db/client');
  await database.init_db();
  await database.createUser(database.db, 'owner', 'owner-access-token');
  await database.createUser(database.db, 'friend', 'friend-access-token');
  await database.createUser(
    database.db,
    'expired',
    'expired-access-token',
    new Date(Date.now() - 1000),
  );
  const { createApp } = await import('../src/app');
  app = createApp();
  app.get('/__test-error', () => {
    throw new Error('private-error-detail');
  });
  app.get(
    '/__test-response-error',
    () => new Response('private-error-detail', { status: 500 }),
  );
  app.listen({ port: 0, hostname: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server?.port}`;
});

test('browser errors use minimal pages and API errors preserve status without private details', async () => {
  for (const [route, status] of [
    ['/missing-key', 404],
    ['/missing/nested/page', 404],
    ['/uploads/missing-file.txt', 404],
    ['/__test-error', 500],
    ['/__test-response-error', 500],
  ] as const) {
    const response = await request(route, { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const page = await response.text();
    expect(page).toContain(String(status));
    expect(page).toContain('[ home ]');
    expect(page).not.toContain('private-error-detail');
    expect(page).not.toContain('<script');
  }
  const missing = await request('/missing-key', {
    headers: { Accept: 'application/json' },
  });
  expect(missing.status).toBe(404);
  expect(await missing.text()).toBe('Not Found');
  const failed = await request('/__test-error', {
    headers: { Accept: 'application/json' },
  });
  expect(failed.status).toBe(500);
  expect(await failed.text()).toBe('Internal Server Error');
});

afterAll(async () => {
  if (app) await app.stop();
  if (client) await client.close();
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

test('SHA-256 hashes exact bytes, including empty and Unicode files', async () => {
  expect(await hashFile(new Blob([]))).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  expect(await hashFile(new Blob(['abc']))).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  expect(await hashFile(new Blob(['初音ミク']))).toHaveLength(64);
});

test('admin login bounds metadata and accepts configured HTTPS proxy origin with secure cookies', async () => {
  const oversized = await request('/adminpane/session', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: dedicatedToken,
      padding: 'x'.repeat(20_000),
    }),
  });
  expect(oversized.status).toBe(400);
  const { env } = await import('../src/utils/env');
  const configuredUrl = env.BASE_URL;
  try {
    env.BASE_URL = 'https://public.fixture.example';
    const signedIn = await request('/adminpane/session', {
      method: 'POST',
      headers: { Origin: env.BASE_URL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: dedicatedToken }),
    });
    expect(signedIn.status).toBe(200);
    const cookieHeader = signedIn.headers.get('set-cookie')!;
    expect(cookieHeader).toContain('Secure');
    expect(cookieHeader).toContain('HttpOnly');
    const cookie = cookieHeader.split(';')[0]!;
    expect(
      (
        await request('/adminpane/api/files/preview', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: env.BASE_URL,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request('/adminpane/api/files/preview', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://attacker.example',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(401);
  } finally {
    env.BASE_URL = configuredUrl;
  }
});

test('migration, upload, and admin lifecycle enforce permissions and preserve data', async () => {
  const [legacy] =
    await client`SELECT api_key FROM users WHERE "user" = 'legacy'`;
  expect(legacy.api_key).toBe('legacy-access-token');
  const small = new File(['abc'], 'hello.txt');
  expect((await request('/')).status).toBe(200);
  const homepage = await (await request('/')).text();
  expect(homepage).toContain('id="uploader"');
  expect(homepage).not.toContain('/adminpane');
  expect((await request('/public/scripts/index.min.js')).status).toBe(200);
  expect((await upload('invalid', [small])).status).toBe(401);
  expect((await upload('expired-access-token', [small])).status).toBe(401);
  const unexpected = new FormData();
  unexpected.append('other', small);
  expect(
    (
      await request('/upload', {
        method: 'POST',
        headers: bearer('friend-access-token'),
        body: unexpected,
      })
    ).status,
  ).toBe(400);
  expect((await upload('friend-access-token', [small], 'NaN')).status).toBe(
    400,
  );
  expect((await upload('friend-access-token', [small], '0')).status).toBe(400);
  expect((await upload('friend-access-token', [small], '169')).status).toBe(
    400,
  );
  expect(
    (
      await upload('friend-access-token', [
        new File([new Uint8Array(1500)], 'large.txt'),
      ])
    ).status,
  ).toBe(413);
  expect(
    (
      await upload(
        'friend-access-token',
        Array.from({ length: 21 }, () => small),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await upload(
        'friend-access-token',
        [
          new File([new Uint8Array(2000)], 'a'),
          new File([new Uint8Array(2000)], 'b'),
        ],
        '1',
      )
    ).status,
  ).toBe(413);
  expect((await client`SELECT * FROM files`).length).toBe(0);

  // Force a database failure on the second file after the first was written.
  await client`ALTER TABLE files ADD CONSTRAINT test_reject_filename CHECK (real_filename <> 'fail.txt')`;
  expect(
    (
      await upload('friend-access-token', [
        small,
        new File(['second'], 'fail.txt'),
      ])
    ).status,
  ).toBe(500);
  expect((await client`SELECT * FROM files`).length).toBe(0);
  expect(
    (await readdir(uploadDir)).filter((name) => name !== 'temp'),
  ).toHaveLength(0);
  await client`ALTER TABLE files DROP CONSTRAINT test_reject_filename`;

  const response = await upload('legacy-access-token', [
    small,
    new File(['初音ミク'], 'ミク.txt'),
  ]);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.files).toHaveLength(2);
  expect(result.url).toBe(result.files[0].url);
  expect(result.files[0].sha256).toBe(await hashFile(small));
  const stored = await client`SELECT * FROM files ORDER BY id`;
  expect(stored).toHaveLength(2);
  expect(stored[1].sha256).toBe(result.files[1].sha256);
  expect(await Bun.file(path.join(uploadDir, stored[0].filename)).text()).toBe(
    'abc',
  );
  await client`UPDATE files SET sha256 = NULL WHERE id = ${stored[0].id}`;
  const backfill = Bun.spawnSync(['bun', 'run', 'build-tools/hash-files.ts'], {
    env: { ...process.env, UPLOADS_DIRECTORY: uploadDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(backfill.exitCode).toBe(0);
  const [backfilled] =
    await client`SELECT sha256 FROM files WHERE id = ${stored[0].id}`;
  expect(backfilled.sha256).toBe(result.files[0].sha256);
  const download = await request('/uploads/' + stored[0].filename);
  expect(download.status).toBe(200);
  expect(await download.text()).toBe('abc');
  const temporary = await upload(
    'friend-access-token',
    [new File([new Uint8Array(1500)], 'large.txt')],
    '1',
  );
  expect(temporary.status).toBe(200);
  const tempResult = await temporary.json();
  expect(tempResult.isTemp).toBe(true);
  expect(
    await Bun.file(path.join(uploadDir, 'temp', tempResult.filename)).exists(),
  ).toBe(true);

  const legacyBody = new FormData();
  legacyBody.append('file', small);
  expect(
    (
      await request('/upload?key=friend-access-token', {
        method: 'POST',
        body: legacyBody,
      })
    ).status,
  ).toBe(200);

  expect((await request('/adminpane')).status).toBe(302);
  expect(
    (await request('/adminpane', { headers: bearer('friend-access-token') }))
      .status,
  ).toBe(302);
  expect((await request('/adminpane/api/users')).status).toBe(401);
  expect(
    (
      await request('/adminpane/api/users', {
        headers: bearer('friend-access-token'),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request('/adminpane/api/users', {
        headers: bearer('expired-access-token'),
      })
    ).status,
  ).toBe(401);
  for (const [route, method] of [
    ['/adminpane/api/users', 'POST'],
    ['/adminpane/api/users/owner/rotate', 'POST'],
    ['/adminpane/api/users/owner', 'DELETE'],
    ['/adminpane/api/files/1', 'DELETE'],
  ]) {
    expect(
      (
        await request(route!, {
          method,
          headers: bearer('friend-access-token'),
        })
      ).status,
    ).toBe(401);
  }
  const panel = await request('/adminpane', {
    headers: bearer('owner-access-token'),
  });
  expect(panel.status).toBe(200);
  expect(panel.headers.get('cache-control')).toBe('no-store');
  expect(await panel.text()).toContain('id="adminPanel"');
  for (const route of ['/adminpane/api/users', '/adminpane/api/files']) {
    expect(
      (await request(route, { headers: bearer(dedicatedToken) })).status,
    ).toBe(200);
  }
  const usersResponse = await request('/adminpane/api/users', {
    headers: bearer('owner-access-token'),
  });
  const usersText = await usersResponse.text();
  expect(usersText).not.toContain('apiKey');
  expect(usersText).not.toContain('sha256:');
  expect(usersText).not.toContain('owner-access-token');
  const login = (token: string, origin = base) =>
    request('/adminpane/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ token }),
    });
  expect((await login('friend-access-token')).status).toBe(401);
  expect(
    (await login('owner-access-token', 'https://attacker.example')).status,
  ).toBe(403);
  const signedIn = await login('owner-access-token');
  expect(signedIn.status).toBe(200);
  const cookieHeader = signedIn.headers.get('set-cookie')!;
  expect(cookieHeader).toContain('HttpOnly');
  expect(cookieHeader).toContain('SameSite=Strict');
  const cookie = cookieHeader.split(';')[0]!;
  expect(
    (await request('/adminpane', { headers: { Cookie: cookie } })).status,
  ).toBe(200);
  expect(
    (
      await request('/adminpane/api/users/friend/rotate', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://attacker.example' },
      })
    ).status,
  ).toBe(401);

  const create = await request('/adminpane/api/users', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: base,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user: 'new_friend' }),
  });
  expect(create.status).toBe(201);
  const created = await create.json();
  const [saved] =
    await client`SELECT api_key FROM users WHERE "user" = 'new_friend'`;
  expect(saved.api_key).toBe(created.token);
  expect((await upload(created.token, [small])).status).toBe(200);
  const rotate = await request('/adminpane/api/users/new_friend/rotate', {
    method: 'POST',
    headers: bearer(dedicatedToken),
  });
  expect(rotate.status).toBe(200);
  const rotated = await rotate.json();
  expect((await upload(created.token, [small])).status).toBe(401);
  expect((await upload(rotated.token, [small])).status).toBe(200);
  expect(
    (
      await request('/adminpane/api/users/new_friend', {
        method: 'DELETE',
        headers: bearer(dedicatedToken),
      })
    ).status,
  ).toBe(200);
  const transferred =
    await client`SELECT files.* FROM files JOIN users ON users.id = files.owner_id WHERE users."user" = 'anonymous'`;
  expect(transferred).toHaveLength(2);
  expect(
    (
      await request('/adminpane/api/users/anonymous', {
        method: 'DELETE',
        headers: bearer(dedicatedToken),
      })
    ).status,
  ).toBe(400);

  const deleteResponse = await request(`/adminpane/api/files/${stored[0].id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: base },
  });
  expect(deleteResponse.status).toBe(200);
  expect(
    await Bun.file(path.join(uploadDir, stored[0].filename)).exists(),
  ).toBe(false);
  expect(
    (await client`SELECT * FROM files WHERE id = ${stored[0].id}`).length,
  ).toBe(0);
  expect(
    (
      await request('/adminpane/api/files/invalid', {
        method: 'DELETE',
        headers: bearer(dedicatedToken),
      })
    ).status,
  ).toBe(400);

  // Deny an account's already-issued session as soon as its key expires.
  await client`UPDATE users SET expires_at = now() - interval '1 second' WHERE "user" = 'owner'`;
  expect(
    (await request('/adminpane/api/users', { headers: { Cookie: cookie } }))
      .status,
  ).toBe(401);
  expect(
    (
      await request('/adminpane/api/users', {
        headers: bearer('owner-access-token'),
      })
    ).status,
  ).toBe(401);
  await client`UPDATE users SET expires_at = NULL WHERE "user" = 'owner'`;
  const ownerLogin = await login('owner-access-token');
  const ownerCookie = ownerLogin.headers.get('set-cookie')!.split(';')[0]!;

  // A rotated account token invalidates its existing browser session immediately.
  expect(
    (
      await request('/adminpane/api/users/owner/rotate', {
        method: 'POST',
        headers: bearer(dedicatedToken),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request('/adminpane/api/users', {
        headers: { Cookie: ownerCookie },
      })
    ).status,
  ).toBe(401);
  const dedicatedLogin = await login(dedicatedToken);
  const dedicatedCookie = dedicatedLogin.headers
    .get('set-cookie')!
    .split(';')[0]!;
  expect(
    (
      await request('/adminpane/session', {
        method: 'DELETE',
        headers: { Cookie: dedicatedCookie, Origin: base },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request('/adminpane/api/users', {
        headers: { Cookie: dedicatedCookie },
      })
    ).status,
  ).toBe(401);
  const { env } = await import('../src/utils/env');
  env.ADMIN_TOKENS = [];
  env.ADMIN_USERS = [];
  expect(
    (await request('/adminpane/api/users', { headers: bearer(dedicatedToken) }))
      .status,
  ).toBe(401);
  expect((await request('/adminpane')).status).toBe(302);
  let limited: Response | undefined;
  for (let i = 0; i < 10; i++) limited = await login('invalid');
  expect(limited?.status).toBe(429);
  expect(
    (await readdir(uploadDir)).some((name) => name.includes('.deleted-')),
  ).toBe(false);
  env.ADMIN_TOKENS = [dedicatedToken, otherAdminToken];
  env.ADMIN_USERS = ['owner'];
}, 30000);

test('portable filenames and Zod environment validation', async () => {
  expect(normalizeFilename('hatsune miku ♡ lifeiseggg__ on x.jpg')).toBe(
    'hatsune_miku_lifeiseggg_on_x.jpg',
  );
  expect(normalizeFilename('ミク.jpg')).toBe('file.jpg');
  expect(normalizeFilename('../CON.txt')).toBe('_CON.txt');
  expect(normalizeFilename('a\r\n"\\b.txt')).not.toMatch(/[\r\n"\\]/);
  expect(normalizeFilename('é.txt')).toBe('e.txt');
  expect(
    normalizeFilename('x'.repeat(1000) + '.jpg').length,
  ).toBeLessThanOrEqual(150);
  const disposition = contentDisposition('miku ♡.jpg');
  expect(
    () => new Headers({ 'Content-Disposition': disposition }),
  ).not.toThrow();
  expect(disposition).not.toMatch(/[^\x20-\x7e]/);
  const { parseEnv } = await import('../src/utils/env');
  expect(parseEnv({ SHOULD_REDIRECT: 'false' }).SHOULD_REDIRECT).toBe(false);
  expect(
    parseEnv({ INIT_CLEANUP: 'true', ZIP_CACHE_TTL_SECONDS: '0' })
      .ZIP_CACHE_TTL_SECONDS,
  ).toBe(0);
  expect(() =>
    parseEnv({ MAX_FILE_SIZE: '-1', DB_PASSWORD: 'secret-never-print' }),
  ).toThrow('MAX_FILE_SIZE');
  expect(() => parseEnv({ SHOULD_REDIRECT: 'yes' })).toThrow('SHOULD_REDIRECT');
  expect(() => parseEnv({ ZIP_CACHE_TTL_SECONDS: 'forever' })).toThrow(
    'ZIP_CACHE_TTL_SECONDS',
  );
  expect(() => parseEnv({ BASE_URL: 'file:///test' })).toThrow('BASE_URL');
});

test('immutable collections stream ZIPs with mandatory revisions and expiry-aware caches', async () => {
  const database = await import('../src/db/client');
  await database.createUser(
    database.db,
    'collection-owner',
    'collection-owner-key',
  );
  const body = new FormData();
  body.append('file', new File(['first'], 'hatsune miku ♡ on x.jpg'));
  body.append('file', new File(['second'], 'same.txt'));
  body.append('file', new File(['third'], 'same.txt'));
  body.append('collectionName', 'Miku ♡ folder');
  const response = await request('/upload', {
    method: 'POST',
    headers: bearer('collection-owner-key'),
    body,
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.collection.name).toBe('Miku_folder');
  expect(
    result.files.map((file: { realFilename: string }) => file.realFilename),
  ).toEqual(['hatsune_miku_on_x.jpg', 'same.txt', 'same_2.txt']);
  const key = result.collection.key;
  expect((await request(`/collections/${key}`)).status).toBe(200);
  expect(
    (await request(`/collections/${key}/info`)).headers.get('cache-control'),
  ).toBe('no-store');
  const info = await (await request(`/collections/${key}/info`)).json();
  expect(info.files).toHaveLength(3);
  const zipRoute = new URL(info.zip).pathname + new URL(info.zip).search;
  expect((await request(zipRoute, { method: 'HEAD' })).status).toBe(200);
  const first = await request(zipRoute);
  expect(first.status).toBe(200);
  expect(first.headers.get('x-zip-cache')).toBe('MISS');
  expect(first.headers.get('cloudflare-cdn-cache-control')).toBe(
    'public, max-age=120, must-revalidate',
  );
  const archive = new Uint8Array(await first.arrayBuffer());
  const contents = unzipSync(archive);
  expect(Object.keys(contents)).toEqual([
    'hatsune_miku_on_x.jpg',
    'same.txt',
    'same_2.txt',
  ]);
  expect(strFromU8(contents['hatsune_miku_on_x.jpg']!)).toBe('first');
  expect(strFromU8(contents['same_2.txt']!)).toBe('third');
  const second = await request(zipRoute);
  expect(second.headers.get('x-zip-cache')).toBe('HIT');
  expect(new Uint8Array(await second.arrayBuffer())).toEqual(archive);
  expect(
    (
      await request(zipRoute, {
        headers: { 'If-None-Match': first.headers.get('etag')! },
      })
    ).status,
  ).toBe(304);
  const cache = (await readdir(path.join(uploadDir, 'zip-cache'))).find(
    (name) => name.endsWith('.zip'),
  )!;
  await utimes(
    path.join(uploadDir, 'zip-cache', cache),
    new Date(0),
    new Date(0),
  );
  const regenerated = await request(zipRoute);
  expect(regenerated.headers.get('x-zip-cache')).toBe('MISS');
  expect(new Uint8Array(await regenerated.arrayBuffer())).toEqual(archive);
  await unlink(path.join(uploadDir, 'zip-cache', cache));
  const simultaneous = await Promise.all([
    request(zipRoute),
    request(zipRoute),
  ]);
  const simultaneousBodies = await Promise.all(
    simultaneous.map((response) => response.arrayBuffer()),
  );
  expect(
    simultaneous.map((response) => response.headers.get('x-zip-cache')).sort(),
  ).toEqual(['HIT', 'MISS']);
  simultaneousBodies.forEach((bytes) =>
    expect(new Uint8Array(bytes)).toEqual(archive),
  );

  const filename = result.files[0].filename;
  const oldHeader = await request(
    `/uploads/${filename}?fn=${encodeURIComponent('hatsune miku ♡ lifeiseggg__ on x.jpg')}`,
  );
  expect(oldHeader.status).toBe(200);
  expect(oldHeader.headers.get('content-disposition')).not.toMatch(
    /[^\x20-\x7e]/,
  );
  const rename = (token: string, name: string) =>
    request(`/api/files/${result.files[0].key}`, {
      method: 'PATCH',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  expect((await rename('friend-access-token', 'not-yours.jpg')).status).toBe(
    404,
  );
  expect((await rename('invalid', 'not-yours.jpg')).status).toBe(404);
  expect((await rename('collection-owner-key', '../renamed.jpg')).status).toBe(
    404,
  );
  expect(
    (
      await request(`/collections/${key}`, {
        method: 'PATCH',
        headers: bearer('collection-owner-key'),
        body: JSON.stringify({ name: 'different' }),
      })
    ).status,
  ).toBe(404);
  expect((await request(`/collections/${key}/download.zip`)).status).toBe(400);
  expect(
    (await request(`/collections/${key}/download.zip?rev=wrong`)).status,
  ).toBe(400);
  const [unchanged] =
    await client`SELECT real_filename FROM files WHERE key = ${result.files[0].key}`;
  expect(unchanged.real_filename).toBe('hatsune_miku_on_x.jpg');
  const updated = await (await request(`/collections/${key}/info`)).json();
  expect(updated.zip).toBe(info.zip);
  expect(updated.files.map((file: { name: string }) => file.name)).toEqual(
    info.files.map((file: { name: string }) => file.name),
  );
  const download = await request(`/${result.files[0].key}?download=1`);
  expect(download.headers.get('location')).toContain('download=1');

  expect(
    (
      await request('/collections', {
        method: 'POST',
        headers: {
          ...bearer('friend-access-token'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'stolen', files: [result.files[0].key] }),
      })
    ).status,
  ).toBe(400);
  const temporary = new FormData();
  temporary.append('file', new File(['temporary'], 'temp.txt'));
  temporary.append('ttl', '1');
  const tempResult = await (
    await request('/upload', {
      method: 'POST',
      headers: bearer('collection-owner-key'),
      body: temporary,
    })
  ).json();
  // Fixture the expiry before grouping, because collections snapshot expiry once.
  await client`UPDATE files SET expires_at = now() + interval '10 seconds' WHERE key = ${tempResult.files[0].key}`;
  const grouped = await request('/collections', {
    method: 'POST',
    headers: {
      ...bearer('collection-owner-key'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'mixed',
      files: [tempResult.files[0].key, result.files[0].key],
    }),
  });
  expect(grouped.status).toBe(201);
  const mixed = await grouped.json();
  const tempInfo = await (
    await request(`/collections/${mixed.key}/info`)
  ).json();
  const tempRoute =
    new URL(tempInfo.zip).pathname + new URL(tempInfo.zip).search;
  const tempZip = await request(tempRoute);
  const ttl = Number(
    /max-age=(\d+)/.exec(tempZip.headers.get('cache-control')!)?.[1],
  );
  expect(ttl).toBeLessThanOrEqual(10);
  expect(ttl).toBeGreaterThanOrEqual(0);
  expect(
    Object.keys(unzipSync(new Uint8Array(await tempZip.arrayBuffer()))),
  ).toHaveLength(2);
  // Simulate elapsed time without sleeping; snapshots otherwise have no edit APIs.
  await client`UPDATE collection_files SET expires_at = now() - interval '1 second' WHERE file_key = ${tempResult.files[0].key}`;
  const afterExpiry = await (
    await request(`/collections/${mixed.key}/info`)
  ).json();
  expect(afterExpiry.files).toHaveLength(2);
  expect(afterExpiry.files[0].available).toBe(false);
  expect(afterExpiry.files[1].available).toBe(true);
  expect(afterExpiry.zip).not.toBe(tempInfo.zip);
  expect((await request(tempRoute)).status).toBe(410);
  const remaining = await request(
    new URL(afterExpiry.zip).pathname + new URL(afterExpiry.zip).search,
  );
  expect(
    Object.keys(unzipSync(new Uint8Array(await remaining.arrayBuffer()))),
  ).toEqual(['hatsune_miku_on_x.jpg']);

  const { env } = await import('../src/utils/env');
  env.ZIP_CACHE_TTL_SECONDS = 0;
  const noCache = await request(
    new URL(updated.zip).pathname + new URL(updated.zip).search,
  );
  expect(noCache.headers.get('cache-control')).toBe('no-store');
  expect(noCache.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
  expect(
    Object.keys(unzipSync(new Uint8Array(await noCache.arrayBuffer()))),
  ).toHaveLength(3);
  env.ZIP_CACHE_TTL_SECONDS = 120;
  const cacheDirectory = env.ZIP_CACHE_DIRECTORY;
  // An unusable cache location still allows streaming a complete archive.
  env.ZIP_CACHE_DIRECTORY = path.join(uploadDir, result.files[0].filename);
  const cacheFailure = await request(zipRoute);
  expect(cacheFailure.status).toBe(200);
  expect(
    Object.keys(unzipSync(new Uint8Array(await cacheFailure.arrayBuffer()))),
  ).toHaveLength(3);
  env.ZIP_CACHE_DIRECTORY = cacheDirectory;
  const removeFile = await import('../src/utils/files');
  const [source] =
    await client`SELECT id FROM files WHERE key = ${result.files[1].key}`;
  expect(await removeFile.removeFile(source.id)).toBe(true);
  const afterDelete = await (await request(`/collections/${key}/info`)).json();
  expect(afterDelete.files).toHaveLength(3);
  expect(afterDelete.files[1].name).toBe('same.txt');
  expect(afterDelete.files[1].available).toBe(false);
  expect(afterDelete.zip).not.toBe(info.zip);
  expect((await request(zipRoute)).status).toBe(410);
  const afterDeleteZip = await request(
    new URL(afterDelete.zip).pathname + new URL(afterDelete.zip).search,
  );
  expect(
    Object.keys(unzipSync(new Uint8Array(await afterDeleteZip.arrayBuffer()))),
  ).toEqual(['hatsune_miku_on_x.jpg', 'same_2.txt']);
  const remove = await import('../src/utils/accounts');
  expect(await remove.removeAccount('collection-owner')).toBe(true);
  const [collection] =
    await client`SELECT collections.* FROM collections JOIN users ON users.id = collections.owner_id WHERE key = ${key} AND users."user" = 'anonymous'`;
  expect(collection.key).toBe(key);
  expect(
    (await readdir(path.join(uploadDir, 'zip-cache'))).some((name) =>
      name.endsWith('.part'),
    ),
  ).toBe(false);
}, 30000);

test('dedup shares bytes across uploads and migration without changing links or collections', async () => {
  const { db, createUser } = await import('../src/db/client');
  const { removeFile } = await import('../src/utils/files');
  await createUser(db, 'dedup', 'dedup-test-key');
  const contents = 'shared deduplication fixture';
  const responses: Response[] = [];
  for (let wave = 0; wave < 2; wave++)
    responses.push(
      ...(await Promise.all(
        Array.from({ length: 3 }, (_, offset) => {
          const index = wave * 3 + offset;
          return upload(
            'dedup-test-key',
            [new File([contents], `copy-${index}.txt`)],
            index % 2 ? '1' : undefined,
          );
        }),
      )),
    );
  expect(responses.map((response) => response.status)).toEqual(
    Array(6).fill(200),
  );
  const uploaded = await Promise.all(
    responses.map((response) => response.json()),
  );
  expect(new Set(uploaded.map((file) => file.key)).size).toBe(6);
  const rows =
    await client`SELECT * FROM files WHERE sha256 = ${uploaded[0].sha256}`;
  const paths = rows.map((row: { filename: string; expires_at: Date | null }) =>
    path.join(uploadDir, row.expires_at ? 'temp' : '', row.filename),
  );
  const original = await stat(paths[0]);
  for (const filepath of paths) {
    const linked = await stat(filepath);
    expect(linked.ino).toBe(original.ino);
    expect(linked.dev).toBe(original.dev);
    expect(await Bun.file(filepath).text()).toBe(contents);
  }
  const grouped = await request('/collections', {
    method: 'POST',
    headers: {
      ...bearer('dedup-test-key'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Duplicates',
      files: uploaded.map((file) => file.key),
    }),
  });
  expect(grouped.status).toBe(201);
  const collection = await grouped.json();
  const before = await (
    await request(`/collections/${collection.key}/info`)
  ).json();

  await client`ALTER TABLE files ADD CONSTRAINT test_reject_dedup_filename CHECK (real_filename <> 'dedup-fail.txt')`;
  const failed = await upload('dedup-test-key', [
    new File([contents], 'dedup-rollback.txt'),
    new File(['rejected'], 'dedup-fail.txt'),
  ]);
  expect(failed.status).toBe(500);
  await client`ALTER TABLE files DROP CONSTRAINT test_reject_dedup_filename`;
  expect(
    (await client`SELECT * FROM files WHERE sha256 = ${uploaded[0].sha256}`)
      .length,
  ).toBe(6);
  for (const filepath of paths)
    expect(await Bun.file(filepath).text()).toBe(contents);

  // Restore one legacy physical duplicate and add untracked legacy copies.
  await unlink(paths[1]);
  await Bun.write(paths[1], contents);
  const legacy = path.join(uploadDir, 'legacy-dedup.bin');
  await Bun.write(legacy, contents);
  await client`UPDATE files SET sha256 = NULL WHERE id = ${rows[1].id}`;
  const migrateDedup = () => {
    const result = Bun.spawnSync(
      ['bun', 'run', 'build-tools/migrate-dedup.ts'],
      {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(result.exitCode).toBe(0);
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  expect(migrateDedup()).toContain('Deduplication complete');
  const migrated = await stat(legacy);
  for (const filepath of paths)
    expect((await stat(filepath)).ino).toBe(migrated.ino);
  const [repaired] =
    await client`SELECT sha256 FROM files WHERE id = ${rows[1].id}`;
  expect(repaired.sha256).toBe(uploaded[0].sha256);
  expect(migrateDedup()).toContain('combined: 0');
  const after = await (
    await request(`/collections/${collection.key}/info`)
  ).json();
  expect(after.zip).toBe(before.zip);
  expect(after.files).toEqual(before.files);

  // Delete permanent and temporary aliases; every remaining download survives.
  await removeFile(rows[0].id);
  await removeFile(rows[1].id);
  expect(await Bun.file(paths[0]).exists()).toBe(false);
  expect(await Bun.file(paths[1]).exists()).toBe(false);
  for (const filepath of paths.slice(2))
    expect(await Bun.file(filepath).text()).toBe(contents);
  expect(await Bun.file(legacy).text()).toBe(contents);
  const oldZip = new URL(before.zip);
  const expiredRevision = await request(oldZip.pathname + oldZip.search);
  expect(expiredRevision.status).toBe(410);
  const updated = await (
    await request(`/collections/${collection.key}/info`)
  ).json();
  expect(updated.zip).not.toBe(before.zip);
  expect(
    updated.files.filter((file: { available: boolean }) => file.available),
  ).toHaveLength(4);
  for (const row of rows.slice(2)) await removeFile(row.id);
  expect((await stat(legacy)).nlink).toBe(1);
  expect(await Bun.file(legacy).text()).toBe(contents);
});

test('UI chunks enforce ownership, exact lengths, atomic publication and cancellation', async () => {
  const { db, createUser } = await import('../src/db/client');
  await createUser(db, 'chunk-owner', 'chunk-owner-token');
  await createUser(db, 'chunk-other', 'chunk-other-token');
  const start = (manifest: unknown, token = 'chunk-owner-token') =>
    request('/ui-upload', {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
  expect(
    (await start({ files: [{ name: 'too-big', size: 1500 }] })).status,
  ).toBe(413);
  expect(
    (await start({ files: [{ name: 'too-big', size: 2500 }], ttl: 1 })).status,
  ).toBe(413);
  expect(
    (
      await start({
        files: [
          { name: 'a', size: 2000 },
          { name: 'b', size: 2000 },
        ],
        ttl: 1,
      })
    ).status,
  ).toBe(413);
  expect(
    (await start({ files: [{ name: 'a', size: 1 }] }, 'invalid')).status,
  ).toBe(401);
  const [before] = await client`SELECT count(*)::int AS count FROM files`;
  const sessionResponse = await start({
    files: [
      { name: 'one.txt', size: 3 },
      { name: 'two.txt', size: 3 },
      { name: 'empty.txt', size: 0 },
    ],
    collectionName: 'Chunk collection',
  });
  expect(sessionResponse.status).toBe(201);
  const session = await sessionResponse.json();
  expect(session.chunkSize).toBe(4 * 1024 * 1024);
  const chunk = (index: number, body: string, token = 'chunk-owner-token') =>
    request(`/ui-upload/${session.id}/${index}/0`, {
      method: 'PUT',
      headers: bearer(token),
      body,
    });
  expect((await chunk(0, 'abc', 'chunk-other-token')).status).toBe(404);
  expect((await chunk(0, 'abcd')).status).toBe(413);
  expect((await chunk(0, 'a')).status).toBe(400);
  expect(
    (
      await request(`/ui-upload/${session.id}/complete`, {
        method: 'POST',
        headers: bearer('chunk-owner-token'),
      })
    ).status,
  ).toBe(409);
  const results = await Promise.all([chunk(0, 'abc'), chunk(1, 'abc')]);
  expect(results.map((result) => result.status)).toEqual([204, 204]);
  const [during] = await client`SELECT count(*)::int AS count FROM files`;
  expect(during.count).toBe(before.count);
  // Retrying a completed chunk replaces just that exact range.
  expect((await chunk(0, 'abc')).status).toBe(204);
  const completed = await request(`/ui-upload/${session.id}/complete`, {
    method: 'POST',
    headers: bearer('chunk-owner-token'),
  });
  expect(completed.status).toBe(200);
  const payload = await completed.json();
  expect(payload.files).toHaveLength(3);
  expect(payload.collection.name).toBe('Chunk_collection');
  expect(payload.files[0].sha256).toBe(await hashFile(new Blob(['abc'])));
  expect(payload.files[2].sha256).toBe(await hashFile(new Blob([])));
  const first = await stat(path.join(uploadDir, payload.files[0].filename));
  expect(
    (await stat(path.join(uploadDir, payload.files[1].filename))).ino,
  ).toBe(first.ino);
  expect((await chunk(0, 'abc')).status).toBe(404);
  const cancelled = await (
    await start({ files: [{ name: 'cancelled', size: 3 }] })
  ).json();
  expect(
    (
      await request(`/ui-upload/${cancelled.id}`, {
        method: 'DELETE',
        headers: bearer('chunk-other-token'),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(`/ui-upload/${cancelled.id}`, {
        method: 'DELETE',
        headers: bearer('chunk-owner-token'),
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await request(`/ui-upload/${cancelled.id}/complete`, {
        method: 'POST',
        headers: bearer('chunk-owner-token'),
      })
    ).status,
  ).toBe(404);
});

test('multipart and raw stream limits cancel reads before the body finishes', async () => {
  const { parseUpload, UploadError, byteLimit, requestStream } =
    await import('../src/utils/upload-stream');
  const { pipeline } = await import('stream/promises');
  const { Writable } = await import('stream');
  const boundary = 'miku-stream-boundary';
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="oversized.txt"\r\nContent-Type: text/plain\r\n\r\n`;
  const body = Buffer.from(
    prefix + 'x'.repeat(1_000_000) + `\r\n--${boundary}--\r\n`,
  );
  let offset = 0,
    cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(body.subarray(offset, offset + 256));
      offset += 256;
      if (offset >= body.length) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamed = new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: stream,
  });
  await expect(parseUpload(streamed)).rejects.toBeInstanceOf(UploadError);
  expect(cancelled).toBe(true);
  expect(offset).toBeLessThan(body.length);
  let rawRead = 0,
    rawCancelled = false;
  const raw = new Request('http://localhost/ui-upload/id/0/0', {
    method: 'PUT',
    body: new ReadableStream({
      pull(controller) {
        rawRead++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        rawCancelled = true;
      },
    }),
  });
  await expect(
    pipeline(
      requestStream(raw),
      byteLimit(3, 'too large', 3),
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    ),
  ).rejects.toBeInstanceOf(UploadError);
  expect(rawCancelled).toBe(true);
  expect(rawRead).toBeLessThan(5);
});

test('admin storage stats use actual filesystem contents and require authentication', async () => {
  const { db, createUser } = await import('../src/db/client');
  await createUser(db, 'stats-fixture', 'stats-fixture-token');
  const bytes = 'stats-unique-physical-content';
  const firstUpload = await upload('stats-fixture-token', [
    new File([bytes], 'one.txt'),
  ]);
  if (firstUpload.status !== 200)
    throw new Error(
      `Stats fixture upload failed: ${firstUpload.status} ${await firstUpload.text()}`,
    );
  expect(
    (await upload('stats-fixture-token', [new File([bytes], 'alias.txt')], '1'))
      .status,
  ).toBe(200);
  expect((await request('/adminpane/api/stats')).status).toBe(401);
  expect(
    (
      await request('/adminpane/api/stats', {
        headers: bearer('stats-fixture-token'),
      })
    ).status,
  ).toBe(401);
  const response = await request('/adminpane/api/stats', {
    headers: bearer(dedicatedToken),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const result = await response.json();
  const rows = await client`SELECT * FROM files`;
  const accounts = await client`SELECT id FROM users`;
  expect(result.accounts).toBe(accounts.length);
  expect(result.fileCount).toBe(rows.length);
  expect(result.logicalBytes).toBe(
    rows.reduce(
      (total: number, row: { size: number }) => total + Number(row.size),
      0,
    ),
  );
  const seen = new Set<string>();
  let physicalBytes = 0;
  for (const directory of [uploadDir, path.join(uploadDir, 'temp')]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const info = await stat(path.join(directory, entry.name));
      const identity = `${info.dev}:${info.ino}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      physicalBytes += info.size;
    }
  }
  expect(result.physicalBytes).toBe(physicalBytes);
  expect(result.physicalBytes).toBeLessThan(result.logicalBytes);
  expect(result.missingFiles).toBe(0);
  if (result.storageAvailableBytes !== undefined)
    expect(result.storageAvailableBytes).toBeGreaterThan(0);
});

test('bulk cleanup validates filters, previews without deletion, and binds confirmation to its admin', async () => {
  const { db, createUser } = await import('../src/db/client');
  const owner = await createUser(db, 'cleanup-filter', 'cleanup-filter-token');
  const uploaded = await upload('cleanup-filter-token', [
    new File(['older-cleanup'], 'old.txt'),
    new File(['recent-cleanup'], 'recent.txt'),
  ]);
  expect(uploaded.status).toBe(200);
  const rows =
    await client`SELECT * FROM files WHERE owner_id = ${owner.id} ORDER BY id`;
  await client`UPDATE files SET created_at = now() - interval '45 days' WHERE id = ${rows[0].id}`;
  for (const body of [
    { ownerId: 0 },
    { ownerId: '1' },
    { olderThanDays: -1 },
    { olderThanDays: 1.5 },
    { olderThanDays: 36501 },
    { olderThanDays: 30, from: '2025-01-01T00:00:00Z' },
    { from: 'invalid' },
    { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    { unexpected: true },
  ]) {
    expect((await adminJson('preview', body)).status).toBe(400);
  }
  expect(
    (await adminJson('preview', { ownerId: owner.id }, 'cleanup-filter-token'))
      .status,
  ).toBe(401);
  const previewResponse = await adminJson('preview', {
    ownerId: owner.id,
    olderThanDays: 30,
  });
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json();
  expect(preview.count).toBe(1);
  expect(preview.logicalBytes).toBe('older-cleanup'.length);
  expect(preview.files).toHaveLength(1);
  expect(preview.files[0].id).toBe(rows[0].id);
  expect(preview.files[0].name).toBe('old.txt');
  expect(preview.files[0].owner).toBe('cleanup-filter');
  expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now());
  expect(
    (await client`SELECT id FROM files WHERE owner_id = ${owner.id}`).length,
  ).toBe(2);
  expect((await adminJson('delete', {})).status).toBe(400);
  const wrongAdmin = await adminJson(
    'delete',
    { previewId: preview.previewId },
    otherAdminToken,
  );
  expect([403, 404, 409]).toContain(wrongAdmin.status);
  const confirmed = await adminJson('delete', { previewId: preview.previewId });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toMatchObject({ deleted: 1, failed: 0 });
  const remaining =
    await client`SELECT id FROM files WHERE owner_id = ${owner.id}`;
  expect(remaining.map((row: { id: number }) => row.id)).toEqual([rows[1].id]);
  const replay = await adminJson('delete', { previewId: preview.previewId });
  expect([404, 409, 410]).toContain(replay.status);
});

test('bulk snapshots exclude new uploads and changed owners, preserving other hardlink aliases', async () => {
  const { db, createUser } = await import('../src/db/client');
  const owner = await createUser(
    db,
    'cleanup-snapshot',
    'cleanup-snapshot-token',
  );
  const other = await createUser(db, 'cleanup-alias', 'cleanup-alias-token');
  const shared = 'snapshot-hardlink-content';
  expect(
    (
      await upload('cleanup-snapshot-token', [
        new File([shared], 'delete.txt'),
        new File(['transfer-this-content'], 'transfer.txt'),
      ])
    ).status,
  ).toBe(200);
  expect(
    (await upload('cleanup-alias-token', [new File([shared], 'keep.txt')]))
      .status,
  ).toBe(200);
  const original =
    await client`SELECT * FROM files WHERE owner_id = ${owner.id} ORDER BY id`;
  const [alias] =
    await client`SELECT * FROM files WHERE owner_id = ${other.id}`;
  const previewResponse = await adminJson('preview', { ownerId: owner.id });
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json();
  expect(preview.count).toBe(2);
  expect(
    (
      await upload('cleanup-snapshot-token', [
        new File(['new-after-preview'], 'new.txt'),
      ])
    ).status,
  ).toBe(200);
  await client`UPDATE files SET owner_id = ${other.id} WHERE id = ${original[1].id}`;
  const confirm = await adminJson('delete', { previewId: preview.previewId });
  expect(confirm.status).toBe(200);
  expect(await confirm.json()).toMatchObject({
    deleted: 1,
    skipped: 1,
    failed: 0,
  });
  const remaining =
    await client`SELECT * FROM files WHERE owner_id = ${owner.id}`;
  expect(remaining).toHaveLength(1);
  expect(remaining[0].real_filename).toBe('new.txt');
  expect((await request('/' + alias.key)).status).toBe(302);
  const aliasDownload = await request('/uploads/' + alias.filename);
  expect(aliasDownload.status).toBe(200);
  expect(await aliasDownload.text()).toBe(shared);
  expect(
    await Bun.file(path.join(uploadDir, original[0].filename)).exists(),
  ).toBe(false);
  expect(
    await Bun.file(path.join(uploadDir, original[1].filename)).exists(),
  ).toBe(true);
});

test('bulk cleanup reports deletion failures and restores the failed file for a fresh retry', async () => {
  const { db, createUser } = await import('../src/db/client');
  const owner = await createUser(
    db,
    'cleanup-failure',
    'cleanup-failure-token',
  );
  expect(
    (
      await upload('cleanup-failure-token', [
        new File(['rollback-preserved'], 'bulk-blocked.txt'),
        new File(['delete-succeeded'], 'bulk-good.txt'),
      ])
    ).status,
  ).toBe(200);
  const [blocked] =
    await client`SELECT * FROM files WHERE owner_id = ${owner.id} AND real_filename = 'bulk-blocked.txt'`;
  const preview = await (
    await adminJson('preview', { ownerId: owner.id })
  ).json();
  await client`CREATE FUNCTION fixture_block_bulk_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.real_filename = 'bulk-blocked.txt' THEN RAISE EXCEPTION 'fixture deletion failure'; END IF; RETURN OLD; END $$`;
  await client`CREATE TRIGGER fixture_block_bulk_delete BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION fixture_block_bulk_delete()`;
  try {
    const result = await adminJson('delete', { previewId: preview.previewId });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      deleted: 1,
      failed: 1,
      skipped: 0,
    });
    expect(
      (await client`SELECT id FROM files WHERE owner_id = ${owner.id}`).length,
    ).toBe(1);
    expect(await Bun.file(path.join(uploadDir, blocked.filename)).text()).toBe(
      'rollback-preserved',
    );
    expect(
      (await readdir(uploadDir)).some((name) => name.includes('.deleted-')),
    ).toBe(false);
    expect(
      (await adminJson('delete', { previewId: preview.previewId })).status,
    ).toBe(409);
  } finally {
    await client`DROP TRIGGER fixture_block_bulk_delete ON files`;
    await client`DROP FUNCTION fixture_block_bulk_delete()`;
  }
  const retry = await (
    await adminJson('preview', { ownerId: owner.id })
  ).json();
  expect(
    await (await adminJson('delete', { previewId: retry.previewId })).json(),
  ).toMatchObject({ deleted: 1, failed: 0 });
});

test('bulk date ranges include the lower boundary and exclude the upper boundary', async () => {
  const { db, createUser } = await import('../src/db/client');
  const owner = await createUser(db, 'cleanup-range', 'cleanup-range-token');
  const uploaded = await upload('cleanup-range-token', [
    new File(['range-before'], 'before.txt'),
    new File(['range-start'], 'start.txt'),
    new File(['range-inside'], 'inside.txt'),
    new File(['range-end'], 'end.txt'),
  ]);
  expect(uploaded.status).toBe(200);
  const rows =
    await client`SELECT * FROM files WHERE owner_id = ${owner.id} ORDER BY id`;
  const dates = [
    '2026-01-01T00:00:00Z',
    '2026-02-01T00:00:00Z',
    '2026-02-15T00:00:00Z',
    '2026-03-01T00:00:00Z',
  ];
  for (let index = 0; index < rows.length; index++)
    await client`UPDATE files SET created_at = ${dates[index]} WHERE id = ${rows[index].id}`;
  const response = await adminJson('preview', {
    ownerId: owner.id,
    from: '2026-02-01T09:00:00+09:00',
    to: '2026-03-01T09:00:00+09:00',
  });
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.count).toBe(2);
  expect(preview.files.map((file: { id: number }) => file.id).sort()).toEqual(
    [rows[1].id, rows[2].id].sort(),
  );
  const confirmed = await adminJson('delete', { previewId: preview.previewId });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toMatchObject({ deleted: 2, failed: 0 });
  const remaining =
    await client`SELECT id FROM files WHERE owner_id = ${owner.id} ORDER BY id`;
  expect(remaining.map((row: { id: number }) => row.id)).toEqual([
    rows[0].id,
    rows[3].id,
  ]);
  const empty = await adminJson('preview', {
    ownerId: owner.id,
    olderThanDays: 36500,
  });
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({
    count: 0,
    logicalBytes: 0,
    files: [],
  });
});

test('temporary direct URLs reject expired files and bound cache lifetime by expiry', async () => {
  const { db, createUser } = await import('../src/db/client');
  const owner = await createUser(db, 'expiry-cache', 'expiry-cache-token');
  const uploaded = await upload(
    'expiry-cache-token',
    [new File([imageFixture()], 'expires.png')],
    '1',
  );
  expect(uploaded.status).toBe(200);
  const [row] = await client`SELECT * FROM files WHERE owner_id = ${owner.id}`;
  await client`UPDATE files SET expires_at = now() + interval '90 seconds' WHERE id = ${row.id}`;
  const direct = '/uploads/temp/' + row.filename;
  const before = await request(direct);
  expect(before.status).toBe(200);
  expect(new Uint8Array(await before.arrayBuffer())).toEqual(
    new Uint8Array(imageFixture()),
  );
  const lifetime = Number(
    before.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1],
  );
  expect(lifetime).toBeGreaterThanOrEqual(0);
  expect(lifetime).toBeLessThanOrEqual(90);
  await client`UPDATE files SET expires_at = now() - interval '1 second' WHERE id = ${row.id}`;
  const expired = await request(direct);
  expect(expired.status).toBe(404);
  expect(expired.headers.get('cache-control')).toBe('no-store');
  expect(
    await Bun.file(path.join(uploadDir, 'temp', row.filename)).exists(),
  ).toBe(true);
  const keyed = await request('/' + row.key);
  expect(keyed.status).toBe(404);
  expect(keyed.headers.get('cache-control')).toBe('no-store');
});

test('bulk preview sampling is capped and expired confirmations cannot delete files', async () => {
  const { db, createUser } = await import('../src/db/client');
  const owner = await createUser(db, 'cleanup-expiry', 'cleanup-expiry-token');
  expect(
    (
      await upload(
        'cleanup-expiry-token',
        Array.from(
          { length: 20 },
          (_, index) => new File(['expiry-' + index], `${index}.txt`),
        ),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await upload('cleanup-expiry-token', [
        new File(['expiry-last'], 'last.txt'),
      ])
    ).status,
  ).toBe(200);
  const response = await adminJson('preview', { ownerId: owner.id });
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.count).toBe(21);
  expect(preview.files).toHaveLength(20);
  const originalNow = Date.now;
  try {
    const advanced = originalNow() + 6 * 60 * 1000;
    Date.now = () => advanced;
    const expired = await adminJson('delete', { previewId: preview.previewId });
    expect([404, 409, 410]).toContain(expired.status);
  } finally {
    Date.now = originalNow;
  }
  expect(
    (await client`SELECT id FROM files WHERE owner_id = ${owner.id}`).length,
  ).toBe(21);
});

test('bounded JSON metadata rejects oversized bodies after authorization', async () => {
  const oversized = JSON.stringify({
    token: dedicatedToken,
    padding: 'x'.repeat(20_000),
  });
  for (const route of [
    '/adminpane/api/files/preview',
    '/adminpane/api/users',
  ]) {
    expect(
      (
        await request(route, {
          method: 'POST',
          headers: {
            ...bearer(dedicatedToken),
            'Content-Type': 'application/json',
          },
          body: oversized,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: oversized,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(route, {
          method: 'POST',
          headers: {
            ...bearer(dedicatedToken),
            'Content-Type': 'application/json',
          },
          body: '{broken',
        })
      ).status,
    ).toBe(400);
  }
  for (const [token, expected] of [
    ['cleanup-range-token', 400],
    ['invalid', 401],
  ] as const) {
    expect(
      (
        await request('/collections', {
          method: 'POST',
          headers: { ...bearer(token), 'Content-Type': 'application/json' },
          body: oversized,
        })
      ).status,
    ).toBe(expected);
  }
  const { readJsonObject } = await import('../src/utils/json-body');
  let reads = 0;
  let cancelled = false;
  const streamed = new Request('http://localhost/adminpane/session', {
    method: 'POST',
    body: new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(1024).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  expect(await readJsonObject(streamed)).toBeNull();
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThan(22);
});

test('crawler image embeds point to actual inline image bytes while download links remain attachments', async () => {
  const { db, createUser } = await import('../src/db/client');
  await createUser(db, 'crawler-image', 'crawler-image-token');
  const bytes = imageFixture();
  const response = await upload('crawler-image-token', [
    new File([bytes], 'preview.png'),
  ]);
  expect(response.status).toBe(200);
  const uploaded = await response.json();
  for (const crawler of ['Discordbot/2.0', 'Twitterbot/1.0', 'TelegramBot']) {
    for (const suffix of ['', '?download=1']) {
      const embed = await request('/' + uploaded.key + suffix, {
        headers: { 'User-Agent': crawler },
      });
      expect(embed.status).toBe(200);
      expect(embed.headers.get('content-type')).toContain('text/html');
      expect(embed.headers.get('cache-control')).toBe('no-store');
      expect(embed.headers.get('vary')).toContain('User-Agent');
      const html = await embed.text();
      expect(metaContent(html, 'og:type')).toBe('image');
      expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');
      expect(metaContent(html, 'twitter:image')).toBe(
        metaContent(html, 'og:image'),
      );
      expect(metaContent(html, 'og:title')).toBeUndefined();
      expect(metaContent(html, 'og:description')).toBeUndefined();
      expect(metaContent(html, 'og:site_name')).toBeUndefined();
      expect(html).not.toContain('<title>');
      const preview = new URL(metaContent(html, 'og:image')!);
      expect(preview.pathname).toBe('/uploads/' + uploaded.filename);
      expect(preview.searchParams.get('download')).not.toBe('1');
      const image = await request(preview.pathname + preview.search);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain('image/png');
      expect(image.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(
        new Uint8Array(bytes),
      );
    }
  }
  const normal = await request('/' + uploaded.key);
  expect(normal.status).toBe(302);
  expect(normal.headers.get('cache-control')).toBe('no-store');
  const download = await request('/' + uploaded.key + '?download=1');
  expect(download.status).toBe(302);
  const destination = new URL(download.headers.get('location')!, base);
  expect(destination.searchParams.get('download')).toBe('1');
  const attachment = await request(destination.pathname + destination.search);
  expect(attachment.status).toBe(200);
  expect(attachment.headers.get('content-disposition')).toMatch(/^attachment;/);
});

test('collection HTML embeds and file info preserve dates and choose the first available raster preview', async () => {
  const { db, createUser } = await import('../src/db/client');
  const owner = await createUser(
    db,
    'collection-embed',
    'collection-embed-token',
  );
  const firstUpload = await upload(
    'collection-embed-token',
    [new File([imageFixture()], 'first.png')],
    '1',
  );
  expect(firstUpload.status).toBe(200);
  const first = await firstUpload.json();
  const secondUpload = await upload('collection-embed-token', [
    new File([imageFixture()], 'second.png'),
    new File(['embed description text'], 'readme.txt'),
  ]);
  expect(secondUpload.status).toBe(200);
  const second = await secondUpload.json();
  const orderedKeys = [first.key, second.files[0].key, second.files[1].key];
  const knownDate = '2026-01-15T12:34:56.000Z';
  await client`UPDATE files SET created_at = ${knownDate} WHERE owner_id = ${owner.id}`;
  const grouped = await request('/collections', {
    method: 'POST',
    headers: {
      ...bearer('collection-embed-token'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Preview collection', files: orderedKeys }),
  });
  expect(grouped.status).toBe(201);
  const collection = await grouped.json();
  const route = '/collections/' + collection.key;
  const { BASE_URL, FILES_URL } = await import('../src/utils/constants');
  const infoResponse = await request(route + '/info');
  expect(infoResponse.status).toBe(200);
  const info = await infoResponse.json();
  expect(info.key).toBe(collection.key);
  expect(info.url).toBe(`${BASE_URL}${route}`);
  expect(Number.isFinite(Date.parse(info.createdAt))).toBe(true);
  expect(info.files.map((file: { key: string }) => file.key)).toEqual(
    orderedKeys,
  );
  for (const file of info.files) {
    expect(file.createdAt).toBe(knownDate);
    expect(file.shareUrl).toBe(`${BASE_URL}/${file.key}`);
    expect(file.url).toBe(`${BASE_URL}/${file.key}?download=1`);
  }
  expect(Number.isFinite(Date.parse(info.files[0].expiresAt))).toBe(true);
  expect(info.files[1].expiresAt).toBeNull();
  const pages = await Promise.all([
    request(route, { headers: { 'User-Agent': 'Discordbot/2.0' } }),
    request(route, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
  ]);
  for (const page of pages) {
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(metaContent(html, 'og:title')).toBe(collection.name);
    expect(metaContent(html, 'og:url')).toBe(`${BASE_URL}${route}`);
    expect(metaContent(html, 'og:description')).toContain('3');
    expect(metaContent(html, 'og:description')).toMatch(/upload/i);
    const preview = new URL(metaContent(html, 'og:image')!);
    expect(preview.origin).toBe(new URL(FILES_URL).origin);
    expect(preview.pathname).toBe('/uploads/temp/' + first.filename);
    expect(preview.searchParams.get('download')).not.toBe('1');
    const image = await request(preview.pathname + preview.search);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toContain('image/png');
    expect(image.headers.get('content-disposition')).toMatch(/^inline;/);
  }
  const hostileName = 'folder\"><script>alert("unsafe")</script>&';
  await client`UPDATE collections SET name = ${hostileName} WHERE key = ${collection.key}`;
  const escaped = await (await request(route)).text();
  expect(metaContent(escaped, 'og:title')).toBe(hostileName);
  expect(escaped).not.toContain('<script>alert("unsafe")</script>');
  expect(escaped).toContain('&lt;script&gt;');
  await client`UPDATE files SET expires_at = now() - interval '1 second' WHERE key = ${first.key}`;
  await client`UPDATE collection_files SET expires_at = now() - interval '1 second' WHERE file_key = ${first.key}`;
  const fallbackHtml = await (await request(route)).text();
  const fallback = new URL(metaContent(fallbackHtml, 'og:image')!);
  expect(fallback.pathname).toBe('/uploads/' + second.files[0].filename);
  const remove = await import('../src/utils/files');
  const [row] =
    await client`SELECT id FROM files WHERE key = ${second.files[0].key}`;
  expect(await remove.removeFile(row.id)).toBe(true);
  const noImage = await (await request(route)).text();
  expect(metaContent(noImage, 'og:image')).toBeUndefined();
  const after = await (await request(route + '/info')).json();
  expect(after.files).toHaveLength(3);
  expect(after.files[0].available).toBe(false);
  expect(after.files[1].available).toBe(false);
  expect(after.files[2].available).toBe(true);
  expect(after.files[1].createdAt).toBe(knownDate);
  // Existing live snapshots can be backfilled; deleted legacy sources stay unknown.
  await client`UPDATE collection_files SET uploaded_at = NULL WHERE collection_key = ${collection.key} AND file_key IN (${second.files[0].key}, ${second.files[1].key})`;
  await client`UPDATE files SET created_at = '2026-02-10T00:00:00Z' WHERE key = ${first.key}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const migrated = Bun.spawnSync(
      ['bun', 'run', 'build-tools/migrate-collections.ts'],
      { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(migrated.exitCode).toBe(0);
  }
  const legacy = await (await request(route + '/info')).json();
  expect(legacy.files[0].createdAt).toBe(knownDate);
  expect(legacy.files[1].createdAt).toBeNull();
  expect(legacy.files[2].createdAt).toBe(knownDate);
});

test('non-raster collections do not advertise unsafe or unsupported image previews', async () => {
  const { db, createUser } = await import('../src/db/client');
  await createUser(db, 'collection-no-image', 'collection-no-image-token');
  const body = new FormData();
  body.append(
    'file',
    new File(
      [
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ],
      'unsafe.svg',
    ),
  );
  body.append('file', new File(['collection text'], 'plain.txt'));
  body.append('collectionName', 'Documents');
  const uploaded = await request('/upload', {
    method: 'POST',
    headers: bearer('collection-no-image-token'),
    body,
  });
  expect(uploaded.status).toBe(200);
  const collection = (await uploaded.json()).collection;
  const page = await request('/collections/' + collection.key, {
    headers: { 'User-Agent': 'Discordbot/2.0' },
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(metaContent(html, 'og:title')).toBe('Documents');
  expect(metaContent(html, 'og:image')).toBeUndefined();
  expect(metaContent(html, 'twitter:card')).toBe('summary');
});

test('QR SVGs stay light on transparent backgrounds and reject invalid text or scale', async () => {
  for (const query of [
    '',
    '?text=',
    '?text=%20%20%09',
    '?text=' + 'x'.repeat(513),
    ...['0', '-1', '0.5', 'NaN', 'Infinity', '9', '1e100', ''].map(
      (scale) => '?text=hello&scale=' + scale,
    ),
  ]) {
    const response = await request('/qrcode' + query);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).not.toContain('image/svg+xml');
  }
  for (const scale of [undefined, 1, 8]) {
    const response = await request(
      '/qrcode?text=' +
        encodeURIComponent('https://fixture.example/file') +
        (scale === undefined ? '' : '&scale=' + scale),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await response.text();
    expect(svg).toContain('<svg');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('fill="#cdd6f4"');
    expect(svg).not.toMatch(
      /fill="(?:white|#fff(?:fff)?|black|#000(?:000)?)"/i,
    );
  }
});

test('untrusted uploads always download as inert attachments regardless of filename query or crawler', async () => {
  const { db, createUser } = await import('../src/db/client');
  await createUser(db, 'untrusted-rendering', 'untrusted-rendering-token');
  const extensions = ['html', 'js', 'xml', 'xhtml', 'pdf', 'json', 'txt'];
  const attack =
    '<html><script>document.cookie="injected=1";fetch("/adminpane/api/users")</script></html>';
  for (const temporary of [false, true]) {
    const uploadResponse = await upload(
      'untrusted-rendering-token',
      extensions.map((extension) => new File([attack], 'attack.' + extension)),
      temporary ? '1' : undefined,
    );
    expect(uploadResponse.status).toBe(200);
    const uploaded = await uploadResponse.json();
    expect(uploaded.files).toHaveLength(extensions.length);
    for (const file of uploaded.files) {
      const direct = '/uploads/' + (temporary ? 'temp/' : '') + file.filename;
      for (const suffix of ['', '?fn=innocent.png&download=0', '?download=1']) {
        const response = await request(direct + suffix);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(
          'application/octet-stream',
        );
        expect(response.headers.get('content-disposition')).toMatch(
          /^attachment;/,
        );
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-security-policy')).toContain(
          'sandbox',
        );
        expect(response.headers.get('content-security-policy')).toContain(
          "default-src 'none'",
        );
        expect(await response.text()).toBe(attack);
      }
      const crawler = await request('/' + file.key, {
        headers: { 'User-Agent': 'Discordbot/2.0' },
      });
      expect(crawler.status).toBe(302);
      expect(crawler.headers.get('content-type') ?? '').not.toContain(
        'text/html',
      );
      const destination = new URL(crawler.headers.get('location')!, base);
      expect(destination.pathname).toBe(direct);
      const followed = await request(destination.pathname + destination.search);
      expect(followed.headers.get('content-type')).toBe(
        'application/octet-stream',
      );
      expect(followed.headers.get('content-disposition')).toMatch(
        /^attachment;/,
      );
    }
    const injectedName =
      'hatsune ♡ "\r\nX-Injected: yes\r\nContent-Type: text/html.svg';
    const query = '?fn=' + encodeURIComponent(injectedName) + '&download=0';
    const safeHeader = await request(
      '/uploads/' +
        (temporary ? 'temp/' : '') +
        uploaded.files[0].filename +
        query,
    );
    expect(safeHeader.status).toBe(200);
    const disposition = safeHeader.headers.get('content-disposition')!;
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).not.toMatch(/[\r\n\u0080-\uFFFF]/);
    expect(safeHeader.headers.get('x-injected')).toBeNull();
    expect(safeHeader.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
  }
});

test('SVG uploads keep their image MIME and exact bytes while script-capable documents remain sandboxed attachments', async () => {
  const { db, createUser } = await import('../src/db/client');
  await createUser(db, 'svg-media-policy', 'svg-media-policy-token');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="cyan"/><script>document.cookie="svg-injection=1";fetch("/adminpane/api/users")</script></svg>';
  for (const temporary of [false, true]) {
    const response = await upload(
      'svg-media-policy-token',
      [new File([svg], 'drawing.svg', { type: 'image/svg+xml' })],
      temporary ? '1' : undefined,
    );
    expect(response.status).toBe(200);
    const file = await response.json();
    const direct = '/uploads/' + (temporary ? 'temp/' : '') + file.filename;
    for (const query of [
      '',
      '?fn=pretend.html&download=0',
      '?fn=pretend.png&download=1',
    ]) {
      const image = await request(direct + query);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/svg+xml');
      expect(image.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(image.headers.get('x-content-type-options')).toBe('nosniff');
      expect(image.headers.get('content-security-policy')).toContain('sandbox');
      expect(image.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      );
      expect(image.headers.get('cache-control')).toBe('no-store');
      expect(await image.text()).toBe(svg);
    }
    const crawler = await request('/' + file.key, {
      headers: { 'User-Agent': 'Discordbot/2.0' },
    });
    expect(crawler.status).toBe(302);
    expect(crawler.headers.get('content-type') ?? '').not.toContain(
      'text/html',
    );
    const destination = new URL(crawler.headers.get('location')!, base);
    const image = await request(destination.pathname + destination.search);
    expect(image.headers.get('content-type')).toBe('image/svg+xml');
    expect(image.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(await image.text()).toBe(svg);
  }
});

test('upload paths reject traversal, directories and symlinks while trusted public assets remain usable', async () => {
  const { db, createUser } = await import('../src/db/client');
  const owner = await createUser(
    db,
    'upload-path-policy',
    'upload-path-policy-token',
  );
  expect(
    (
      await upload('upload-path-policy-token', [
        new File(['path-fixture'], 'path.txt'),
      ])
    ).status,
  ).toBe(200);
  expect(
    (
      await upload(
        'upload-path-policy-token',
        [new File(['temp-path-fixture'], 'temp.txt')],
        '1',
      )
    ).status,
  ).toBe(200);
  const rows =
    await client`SELECT * FROM files WHERE owner_id = ${owner.id} ORDER BY id`;
  const external = path.join(
    path.dirname(uploadDir),
    path.basename(uploadDir) + '-outside.txt',
  );
  await Bun.write(external, 'outside-secret-not-downloadable');
  try {
    for (const prefix of ['/uploads/', '/uploads/temp/']) {
      for (const attack of [
        '%2e%2e%2f' + path.basename(external),
        '%252e%252e%252f' + path.basename(external),
        '..%5c' + path.basename(external),
        '%2f' + external.replace(/\\/g, '/'),
        '%00' + rows[0].filename,
      ]) {
        const result = await request(prefix + attack);
        expect([400, 404]).toContain(result.status);
        expect(await result.text()).not.toContain(
          'outside-secret-not-downloadable',
        );
      }
    }
    for (const row of rows) {
      const directory = row.expires_at
        ? path.join(uploadDir, 'temp')
        : uploadDir;
      const original = path.join(directory, row.filename);
      const backup = original + '.fixture-backup';
      await rename(original, backup);
      try {
        await mkdir(original);
        expect(
          (
            await request(
              '/uploads/' + (row.expires_at ? 'temp/' : '') + row.filename,
            )
          ).status,
        ).toBe(404);
        await rm(original, { recursive: true });
        let linked = false;
        try {
          await symlink(external, original, 'file');
          linked = true;
        } catch (error) {
          if (
            !['EPERM', 'EACCES'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
        }
        if (linked) {
          const response = await request(
            '/uploads/' + (row.expires_at ? 'temp/' : '') + row.filename,
          );
          expect(response.status).toBe(404);
          expect(await response.text()).not.toContain(
            'outside-secret-not-downloadable',
          );
          await unlink(original);
        }
      } finally {
        await rm(original, { recursive: true, force: true });
        await rename(backup, original);
      }
    }
  } finally {
    await unlink(external);
  }
  await client`UPDATE files SET expires_at = now() - interval '1 second' WHERE id = ${rows[1].id}`;
  for (const route of [
    '/uploads/temp/' + rows[1].filename,
    '/uploads/temp%2F' + rows[1].filename,
    '/uploads/temp%252F' + rows[1].filename,
  ]) {
    const expired = await request(route);
    expect(expired.status).toBe(404);
    expect(await expired.text()).not.toContain('temp-path-fixture');
  }
  const homepage = await request('/');
  expect(homepage.status).toBe(200);
  expect(homepage.headers.get('content-type')).toContain('text/html');
  const script = await request('/public/scripts/index.min.js');
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toMatch(
    /(?:javascript|ecmascript)/,
  );
  expect(script.headers.get('content-disposition') ?? '').not.toMatch(
    /^attachment;/,
  );
});

test('external symlink members become unavailable to collections, ZIP revisions and crawler previews', async () => {
  const { db, createUser } = await import('../src/db/client');
  await createUser(db, 'collection-symlink', 'collection-symlink-token');
  const external = path.join(
    path.dirname(uploadDir),
    path.basename(uploadDir) + '-outside-image.png',
  );
  await Bun.write(external, 'external-image-secret');
  try {
    for (const temporary of [false, true]) {
      const uploaded = await (
        await upload(
          'collection-symlink-token',
          [new File([imageFixture()], 'inside.png')],
          temporary ? '1' : undefined,
        )
      ).json();
      const grouped = await request('/collections', {
        method: 'POST',
        headers: {
          ...bearer('collection-symlink-token'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: temporary ? 'Temporary image' : 'Permanent image',
          files: [uploaded.key],
        }),
      });
      expect(grouped.status).toBe(201);
      const collection = await grouped.json();
      const collectionRoute = '/collections/' + collection.key;
      const originalInfo = await (
        await request(collectionRoute + '/info')
      ).json();
      expect(originalInfo.files[0].available).toBe(true);
      const originalZip = new URL(originalInfo.zip);
      const original = path.join(
        uploadDir,
        temporary ? 'temp' : '',
        uploaded.filename,
      );
      const backup = original + '.safe-backup';
      await rename(original, backup);
      let linked = false;
      try {
        try {
          await symlink(external, original, 'file');
          linked = true;
        } catch (error) {
          if (
            !['EPERM', 'EACCES'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
        }
        if (linked) {
          const unavailable = await (
            await request(collectionRoute + '/info')
          ).json();
          expect(unavailable.files).toHaveLength(1);
          expect(unavailable.files[0].available).toBe(false);
          expect(unavailable.zip).toBeNull();
          const html = await (await request(collectionRoute)).text();
          expect(metaContent(html, 'og:image')).toBeUndefined();
          expect(
            (await request(originalZip.pathname + originalZip.search)).status,
          ).toBe(410);
          const crawler = await request('/' + uploaded.key, {
            headers: { 'User-Agent': 'Discordbot/2.0' },
          });
          expect(crawler.status).toBe(404);
          expect(await crawler.text()).not.toContain('external-image-secret');
          expect((await request('/' + uploaded.key)).status).toBe(404);
        }
      } finally {
        if (linked) await unlink(original);
        await rename(backup, original);
      }
      const restored = await (await request(collectionRoute + '/info')).json();
      expect(restored.files[0].available).toBe(true);
      expect(restored.zip).toBe(originalInfo.zip);
      const archive = await request(originalZip.pathname + originalZip.search);
      expect(archive.status).toBe(200);
      expect(
        unzipSync(new Uint8Array(await archive.arrayBuffer()))['inside.png'],
      ).toEqual(new Uint8Array(imageFixture()));
    }
  } finally {
    await unlink(external);
  }
});

test('legacy streaming reservations enforce per-account and global caps and release after completion', async () => {
  const { db, createUser } = await import('../src/db/client');
  const { UploadHandler } = await import('../src/upload');
  const token = 'legacy-cap-owner-token';
  await createUser(db, 'legacy-cap-owner', token);
  const hold = (accessToken: string, gate: Promise<void>) => {
    let started!: () => void;
    const consuming = new Promise<void>((resolve) => {
      started = resolve;
    });
    let pulls = 0;
    const boundary = 'miku-capped-stream';
    const body = new ReadableStream({
      async pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="held.txt"\r\nContent-Type: text/plain\r\n\r\n`,
            ),
          );
        } else {
          started();
          await gate;
          controller.enqueue(Buffer.from(`held-upload\r\n--${boundary}--\r\n`));
          controller.close();
        }
      },
    });
    return {
      consuming,
      result: UploadHandler({
        request: new Request(base + '/upload', {
          method: 'POST',
          headers: {
            ...bearer(accessToken),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        }),
      }),
    };
  };
  const attempt = async (accessToken: string) => {
    let cancelled = false;
    const response = await UploadHandler({
      request: new Request(base + '/upload', {
        method: 'POST',
        headers: bearer(accessToken),
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(cancelled).toBe(true);
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = Array.from({ length: 4 }, () => hold(token, gate));
  try {
    await Promise.all(held.map((entry) => entry.consuming));
    await attempt(token);
  } finally {
    release();
  }
  expect(
    (await Promise.all(held.map((entry) => entry.result))).map(
      (response) => response.status,
    ),
  ).toEqual(Array(4).fill(200));
  expect(
    (await upload(token, [new File(['slot-released'], 'released.txt')])).status,
  ).toBe(200);
  const tokens: string[] = [];
  for (let index = 0; index < 5; index++) {
    const globalToken = `legacy-global-cap-${index}-token`;
    tokens.push(globalToken);
    await createUser(db, `legacy-global-cap-${index}`, globalToken);
  }
  let releaseGlobal!: () => void;
  const globalGate = new Promise<void>((resolve) => {
    releaseGlobal = resolve;
  });
  const globalHeld = tokens
    .slice(0, 4)
    .flatMap((accessToken) =>
      Array.from({ length: 4 }, () => hold(accessToken, globalGate)),
    );
  try {
    await Promise.all(globalHeld.map((entry) => entry.consuming));
    await attempt(tokens[4]!);
  } finally {
    releaseGlobal();
  }
  expect(
    (await Promise.all(globalHeld.map((entry) => entry.result))).map(
      (response) => response.status,
    ),
  ).toEqual(Array(16).fill(200));
  expect(
    (
      await upload(tokens[4]!, [
        new File(['global-slot-released'], 'global-released.txt'),
      ])
    ).status,
  ).toBe(200);
}, 30000);

test('ZIP compression caps reject extra generators while allowing HEAD and cached downloads and releasing cancellations', async () => {
  const { db, createUser } = await import('../src/db/client');
  const { readCollection } = await import('../src/utils/collections');
  const { collectionZip } = await import('../src/utils/zip');
  const { env, parseEnv } = await import('../src/utils/env');
  await createUser(db, 'zip-cap-owner', 'zip-cap-owner-token');
  const uploaded = await (
    await upload('zip-cap-owner-token', [
      new File(['zip-cap-fixture'], 'zip.txt'),
    ])
  ).json();
  const collections = [];
  for (let index = 0; index < 6; index++) {
    const grouped = await request('/collections', {
      method: 'POST',
      headers: {
        ...bearer('zip-cap-owner-token'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: `zip-cap-${index}`, files: [uploaded.key] }),
    });
    expect(grouped.status).toBe(201);
    const collection = await readCollection((await grouped.json()).key);
    if (!collection) throw new Error('Missing ZIP cap fixture');
    collections.push(collection);
  }
  for (const value of ['0', '33', '1.5'])
    expect(() => parseEnv({ ZIP_MAX_CONCURRENT: value })).toThrow(
      'ZIP_MAX_CONCURRENT',
    );
  const previousTTL = env.ZIP_CACHE_TTL_SECONDS;
  const previousCap = env.ZIP_MAX_CONCURRENT;
  const held: Response[] = [];
  const zipRequest = (method = 'GET') =>
    new Request(base + '/fixture.zip', { method });
  try {
    env.ZIP_MAX_CONCURRENT = 4;
    env.ZIP_CACHE_TTL_SECONDS = 120;
    const warm = await collectionZip(collections[5]!, zipRequest());
    expect(warm.status).toBe(200);
    await warm.arrayBuffer();
    env.ZIP_CACHE_TTL_SECONDS = 0;
    for (const collection of collections.slice(0, 4)) {
      const response = await collectionZip(collection, zipRequest());
      expect(response.status).toBe(200);
      held.push(response);
    }
    const rejected = await collectionZip(collections[4]!, zipRequest());
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('5');
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    const head = await collectionZip(collections[4]!, zipRequest('HEAD'));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    env.ZIP_CACHE_TTL_SECONDS = 120;
    const cached = await collectionZip(collections[5]!, zipRequest());
    expect(cached.status).toBe(200);
    expect(cached.headers.get('x-zip-cache')).toBe('HIT');
    expect(
      strFromU8(
        unzipSync(new Uint8Array(await cached.arrayBuffer()))['zip.txt']!,
      ),
    ).toBe('zip-cap-fixture');
    env.ZIP_CACHE_TTL_SECONDS = 0;
    await held.pop()!.body!.cancel();
    const retry = await collectionZip(collections[4]!, zipRequest());
    expect(retry.status).toBe(200);
    expect(
      strFromU8(
        unzipSync(new Uint8Array(await retry.arrayBuffer()))['zip.txt']!,
      ),
    ).toBe('zip-cap-fixture');
    const broken = {
      ...collections[4]!,
      members: collections[4]!.members.map((file) => ({
        ...file,
        filepath: path.join(uploadDir, 'missing-zip-source.txt'),
      })),
    };
    const failed = await collectionZip(broken, zipRequest());
    expect(failed.status).toBe(200);
    await expect(failed.arrayBuffer()).rejects.toThrow();
    const afterFailure = await collectionZip(collections[4]!, zipRequest());
    expect(afterFailure.status).toBe(200);
    await afterFailure.arrayBuffer();
    const aborted = new AbortController();
    aborted.abort();
    const preAborted = await collectionZip(
      collections[4]!,
      new Request(base + '/fixture.zip', { signal: aborted.signal }),
    );
    expect(preAborted.status).toBe(200);
    // Give abort cleanup its microtasks without reading or cancelling the response body.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterAbort = await collectionZip(collections[4]!, zipRequest());
    expect(afterAbort.status).toBe(200);
    await afterAbort.arrayBuffer();
  } finally {
    await Promise.allSettled(held.map((response) => response.body!.cancel()));
    env.ZIP_CACHE_TTL_SECONDS = previousTTL;
    env.ZIP_MAX_CONCURRENT = previousCap;
  }
  const released = await collectionZip(collections[4]!, zipRequest());
  expect(released.status).toBe(200);
  await released.arrayBuffer();
});

test('parallel chunk manifests admit exactly four sessions per owner and thirty-two globally without reservation leaks', async () => {
  const { db, createUser } = await import('../src/db/client');
  const tokens: string[] = [];
  for (let index = 0; index < 9; index++) {
    const token = `chunk-session-cap-${index}-token`;
    tokens.push(token);
    await createUser(db, `chunk-session-cap-${index}`, token);
  }
  const start = (token: string) =>
    request('/ui-upload', {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: Array.from({ length: 20 }, (_, index) => ({
          name: `empty-${index}.txt`,
          size: 0,
        })),
      }),
    });
  const owned: { id: string; token: string }[] = [];
  try {
    for (const token of tokens.slice(0, 8)) {
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => start(token)),
      );
      for (const response of responses)
        if (response.status === 201)
          owned.push({ id: (await response.json()).id, token });
      expect(responses.map((response) => response.status)).toEqual([
        201, 201, 201, 201,
      ]);
      expect((await start(token)).status).toBe(429);
    }
    expect(owned).toHaveLength(32);
    expect((await start(tokens[8]!)).status).toBe(429);
  } finally {
    const cleanup = await Promise.all(
      owned.map(({ id, token }) =>
        request('/ui-upload/' + id, {
          method: 'DELETE',
          headers: bearer(token),
        }),
      ),
    );
    expect(cleanup.map((response) => response.status)).toEqual(
      Array(owned.length).fill(204),
    );
  }
  const released = await start(tokens[8]!);
  expect(released.status).toBe(201);
  const final = await released.json();
  expect(
    (
      await request('/ui-upload/' + final.id, {
        method: 'DELETE',
        headers: bearer(tokens[8]!),
      })
    ).status,
  ).toBe(204);
}, 30000);

test('accounts CLI local commands avoid database, HTTP and upload storage initialization', async () => {
  const disconnected = { DB_HOST: '127.0.0.1', DB_PORT: '1' };
  for (const command of ['help', 'admin-token', 'exit']) {
    const result = accountsCLI([command], undefined, disconnected);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).not.toContain('ECONNREFUSED');
  }
  for (const [args, message] of [
    [['unknown-command'], 'Unknown command'],
    [['delfiles', 'anonymous'], 'delfiles requires upload storage'],
    [['genkey', 'invalid name'], 'Usage: genkey'],
  ] as const) {
    const result = accountsCLI([...args], undefined, disconnected);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(message);
    expect(result.stderr.toString()).not.toContain('ECONNREFUSED');
  }
  const emptyInput = accountsCLI([], '', disconnected);
  expect(emptyInput.exitCode).toBe(0);
  await expect(
    stat(path.join(uploadDir, 'accounts-must-not-create-storage')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await request('/')).status).toBe(200);
}, 30000);

test('piped accounts commands drain at EOF, serialize account changes and stop after exit', async () => {
  const script =
    [
      'genkey cli-piped 1h cli-piped-explicit-token',
      'listusers',
      'getkey cli-piped',
      'rotatekey cli-piped',
      'getkey cli-piped',
      'deluser cli-piped',
      'genkey cli-eof 1h cli-eof-explicit-token',
    ].join('\n') + '\n';
  const result = accountsCLI([], script);
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain('Created cli-piped');
  expect(output).toContain(
    'Access key for cli-piped: cli-piped-explicit-token',
  );
  expect(output).toContain('Old token revoked');
  expect(output).toContain('Deleted cli-piped; files transferred to anonymous');
  expect(output).toContain('Created cli-eof');
  expect(
    (await client`SELECT id FROM users WHERE "user" = 'cli-piped'`).length,
  ).toBe(0);
  const [saved] =
    await client`SELECT api_key, expires_at FROM users WHERE "user" = 'cli-eof'`;
  expect(saved.api_key).toBe('cli-eof-explicit-token');
  expect(new Date(saved.expires_at).getTime()).toBeGreaterThan(Date.now());
  const oneShot = accountsCLI(['getkey', 'cli-eof']);
  expect(oneShot.exitCode).toBe(0);
  expect(oneShot.stdout.toString()).toContain('cli-eof-explicit-token');
  const duplicate = accountsCLI([
    'genkey',
    'cli-eof',
    '1h',
    'must-not-replace',
  ]);
  expect(duplicate.exitCode).toBe(1);
  expect(duplicate.stderr.toString()).toContain('Account already exists');
  const [unchanged] =
    await client`SELECT api_key FROM users WHERE "user" = 'cli-eof'`;
  expect(unchanged.api_key).toBe('cli-eof-explicit-token');
  for (const [name, ttl, duration] of [
    ['cli-minutes', '30m', 30 * 60 * 1000],
    ['cli-mixed-time', '1d30m', (24 * 60 + 30) * 60 * 1000],
  ] as const) {
    const before = Date.now();
    const durationResult = accountsCLI(['genkey', name, ttl]);
    expect(durationResult.exitCode).toBe(0);
    const [timed] =
      await client`SELECT expires_at FROM users WHERE "user" = ${name}`;
    const expires = new Date(timed.expires_at).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + duration);
    expect(expires).toBeLessThanOrEqual(Date.now() + duration);
  }
  const overflowing = accountsCLI([
    'genkey',
    'cli-overflow-ttl',
    '9'.repeat(400) + 'd',
  ]);
  expect(overflowing.exitCode).toBe(1);
  expect(overflowing.stderr.toString()).toMatch(
    /duration|expiry|expires|range/i,
  );
  expect(
    (await client`SELECT id FROM users WHERE "user" = 'cli-overflow-ttl'`)
      .length,
  ).toBe(0);
  const exit = accountsCLI(
    [],
    'exit\ngenkey cli-after-exit 1h must-not-exist\n',
  );
  expect(exit.exitCode).toBe(0);
  expect(
    (await client`SELECT id FROM users WHERE "user" = 'cli-after-exit'`).length,
  ).toBe(0);
  const recover = accountsCLI(
    [],
    'invalid-command\ngenkey cli-after-error 1h recovered-command-token\n',
  );
  expect(recover.exitCode).toBe(1);
  expect(recover.stdout.toString()).toContain('Created cli-after-error');
  const [recovered] =
    await client`SELECT api_key FROM users WHERE "user" = 'cli-after-error'`;
  expect(recovered.api_key).toBe('recovered-command-token');
  await expect(
    stat(path.join(uploadDir, 'accounts-must-not-create-storage')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);

test('accounts CLI rotation revokes live web tokens and admin sessions without touching stored files', async () => {
  const create = accountsCLI([
    'genkey',
    'cli-web-admin',
    '1h',
    'cli-web-old-token',
  ]);
  expect(create.exitCode).toBe(0);
  const { env } = await import('../src/utils/env');
  const originalAdmins = env.ADMIN_USERS;
  env.ADMIN_USERS = [...originalAdmins, 'cli-web-admin'];
  try {
    const { adminFromToken, startAdminSession } =
      await import('../src/utils/admin-auth');
    const identity = await adminFromToken('cli-web-old-token');
    if (!identity) throw new Error('Missing CLI admin fixture');
    const cookie = startAdminSession(identity, new Request(base)).split(
      ';',
    )[0]!;
    expect(
      (await request('/adminpane/api/users', { headers: { Cookie: cookie } }))
        .status,
    ).toBe(200);
    const before = await upload('cli-web-old-token', [
      new File(['cli-keeps-file-bytes'], 'kept.txt'),
    ]);
    expect(before.status).toBe(200);
    const uploaded = await before.json();
    const rotated = accountsCLI(['rotatekey', 'cli-web-admin']);
    expect(rotated.exitCode).toBe(0);
    const [account] =
      await client`SELECT api_key FROM users WHERE "user" = 'cli-web-admin'`;
    expect(account.api_key).not.toBe('cli-web-old-token');
    expect(rotated.stdout.toString()).toContain(account.api_key);
    expect(
      (await request('/adminpane/api/users', { headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
    expect(
      (
        await upload('cli-web-old-token', [
          new File(['revoked'], 'revoked.txt'),
        ])
      ).status,
    ).toBe(401);
    expect(
      (
        await upload(account.api_key, [
          new File(['replacement-accepted'], 'replacement.txt'),
        ])
      ).status,
    ).toBe(200);
    const deleted = accountsCLI(['deluser', 'cli-web-admin']);
    expect(deleted.exitCode).toBe(0);
    expect(
      (await client`SELECT id FROM users WHERE "user" = 'cli-web-admin'`)
        .length,
    ).toBe(0);
    const [file] =
      await client`SELECT users."user" FROM files JOIN users ON users.id = files.owner_id WHERE files.key = ${uploaded.key}`;
    expect(file.user).toBe('anonymous');
    expect(await Bun.file(path.join(uploadDir, uploaded.filename)).text()).toBe(
      'cli-keeps-file-bytes',
    );
    await expect(
      stat(path.join(uploadDir, 'accounts-must-not-create-storage')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await request('/adminpane/api/users', {
          headers: bearer(account.api_key),
        })
      ).status,
    ).toBe(401);
  } finally {
    env.ADMIN_USERS = originalAdmins;
  }
}, 30000);

test('legacy HTTP upload returns 413 before a slow sender finishes', async () => {
  const { db, createUser } = await import('../src/db/client');
  await createUser(db, 'http-recovery', 'http-recovery-token');
  const { request: httpRequest } = await import('http');
  const boundary = 'miku-slow-http';
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="ttl"\r\n\r\n1\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="oversized.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const result = await new Promise<{ status: number; sent: number }>(
    (resolve, reject) => {
      let sent = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const req = httpRequest(
        base + '/upload',
        {
          method: 'POST',
          headers: {
            ...bearer('http-recovery-token'),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            // Bun 1.3.14 shares HTTP/fetch client pools and mishandles reuse
            // after an intentionally unfinished body. Native Node recovers normally.
            Connection: 'close',
          },
        },
        (response) => {
          clearTimeout(timer);
          response.resume();
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, sent });
            req.destroy();
          });
        },
      );
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.setTimeout(3000, () =>
        req.destroy(new Error('Streaming response timeout')),
      );
      req.write(prefix);
      const send = () => {
        if (sent >= 20_000) {
          req.end(`\r\n--${boundary}--\r\n`);
          return;
        }
        sent += 256;
        req.write(Buffer.alloc(256));
        timer = setTimeout(send, 5);
      };
      send();
    },
  );
  expect(result.status).toBe(413);
  expect(result.sent).toBeLessThan(20_000);
  const recovery = await upload('http-recovery-token', [
    new File(['recovered-after-overflow'], 'recovery.txt'),
  ]);
  expect(recovery.status).toBe(200);
});
