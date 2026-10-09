import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHash, randomBytes } from 'crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { unzipSync } from 'fflate';

// This suite recreates its schema. Never point it at the application database.
if (
  process.env.MIKU_TEST_DATABASE !== '1' ||
  process.env.DB_NAME !== 'miku_test'
) {
  throw new Error(
    'Use a disposable miku_test database and MIKU_TEST_DATABASE=1',
  );
}

const MiB = 1024 * 1024;
const fileSize = 6 * MiB;
const adminToken = 'stress-fixture-admin';
const owners = Array.from({ length: 4 }, (_, index) => `stress-owner-${index}`);
const metrics = new Map<string, number[]>();
const statuses = new Map<number, number>();
const openSessions = new Map<string, string>();
let nodeClientRSS: { baselineMiB: number; peakMiB: number } | undefined;
const usesNode = process.env.MIKU_STRESS_TRANSPORT !== 'bun';
const originalTemp = {
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  TMPDIR: process.env.TMPDIR,
};
let directory: string;
let uploads: string;
let staging: string;
let base: string;
let client: SQL;
let app: ReturnType<typeof import('../src/app').createApp>;

interface UploadedFile {
  key: string;
  filename: string;
  realFilename: string;
  sha256: string;
}
interface UploadResult extends UploadedFile {
  files: UploadedFile[];
}
interface Session {
  id: string;
  chunkSize: number;
}
interface CollectionInfo {
  zip: string;
  files: { key: string; name: string }[];
}
interface Specification {
  token: string;
  group: number;
  name: string;
  chunked: boolean;
}
const nodeControl = async (
  specifications: Specification[],
  payloads: Uint8Array[],
): Promise<PromiseSettledResult<UploadResult>[]> => {
  await Promise.all(
    payloads.map((bytes, index) =>
      writeFile(path.join(directory, `payload-${index}.bin`), bytes),
    ),
  );
  const child = Bun.spawn(
    ['node', path.join(import.meta.dir, 'helpers', 'stress-client.mjs')],
    {
      env: {
        ...process.env,
        MIKU_STRESS_BASE: base,
        MIKU_STRESS_SPECS: JSON.stringify(specifications),
        MIKU_STRESS_DIR: directory,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(child.stdout).text();
  if (await child.exited)
    throw new Error(await new Response(child.stderr).text());
  const data = JSON.parse(output) as {
    results: PromiseSettledResult<UploadResult>[];
    metrics: Record<string, number[]>;
    statuses: Record<string, number>;
    rssBaselineMiB: number;
    rssPeakMiB: number;
  };
  for (const [kind, values] of Object.entries(data.metrics))
    for (const elapsed of values) observe(kind, elapsed);
  for (const [status, count] of Object.entries(data.statuses))
    statuses.set(Number(status), (statuses.get(Number(status)) ?? 0) + count);
  nodeClientRSS = {
    baselineMiB: Number(data.rssBaselineMiB.toFixed(1)),
    peakMiB: Number(data.rssPeakMiB.toFixed(1)),
  };
  return data.results;
};
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const observe = (kind: string, elapsed: number) => {
  const values = metrics.get(kind) ?? [];
  values.push(elapsed);
  metrics.set(kind, values);
};
const request = async (
  route: string,
  options: RequestInit = {},
  kind = 'request',
) => {
  const target = route.startsWith('http')
    ? new URL(route).pathname + new URL(route).search
    : route;
  const start = performance.now();
  const headers = new Headers(options.headers);
  if (process.env.MIKU_STRESS_CONNECTION_CLOSE === '1')
    headers.set('Connection', 'close');
  let response: Response;
  try {
    response = await fetch(base + target, {
      ...options,
      headers,
      redirect: 'manual',
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `${options.method ?? 'GET'} ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  observe(kind, performance.now() - start);
  statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  if (response.status >= 500)
    throw new Error(
      `${options.method ?? 'GET'} ${target}: ${response.status} ${await response.text()}`,
    );
  return response;
};
const jsonRequest = (
  route: string,
  token: string,
  value: unknown,
  kind = 'request',
) =>
  request(
    route,
    {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    },
    kind,
  );
const startSession = async (
  token: string,
  size: number,
  name: string,
): Promise<Session> => {
  const response = await jsonRequest(
    '/ui-upload',
    token,
    { files: [{ name, size }] },
    'manifest',
  );
  expect(response.status).toBe(201);
  const session = (await response.json()) as Session;
  expect(openSessions.has(session.id)).toBe(false);
  openSessions.set(session.id, token);
  return session;
};
const discard = async (session: Session, token: string) => {
  expect(
    (
      await request(`/ui-upload/${session.id}`, {
        method: 'DELETE',
        headers: bearer(token),
      })
    ).status,
  ).toBe(204);
  openSessions.delete(session.id);
};
const readFile = async (file: UploadedFile, expected: string) => {
  const start = performance.now();
  const response = await request(
    `/uploads/${file.filename}?download=1`,
    {},
    'download',
  );
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  observe('download_body', performance.now() - start);
  expect(digest(bytes)).toBe(expected);
  return bytes.length;
};
const uploadChunks = async (
  token: string,
  bytes: Uint8Array,
  name: string,
): Promise<UploadResult> => {
  const session = await startSession(token, bytes.length, name);
  const chunks = Array.from(
    { length: Math.ceil(bytes.length / session.chunkSize) },
    (_, index) => index,
  );
  const responses = await Promise.all(
    chunks.map((index) =>
      request(
        `/ui-upload/${session.id}/0/${index}`,
        {
          method: 'PUT',
          headers: bearer(token),
          body: new Blob([
            new Uint8Array(
              bytes.subarray(
                index * session.chunkSize,
                (index + 1) * session.chunkSize,
              ),
            ),
          ]),
        },
        'chunk',
      ),
    ),
  );
  for (const [index, response] of responses.entries()) {
    if (response.status !== 204)
      throw new Error(
        `Chunk ${session.id} ${name} (${token}) part${index}: ${response.status} ${await response.text()}`,
      );
    expect(response.status).toBe(204);
  }
  const response = await request(
    `/ui-upload/${session.id}/complete`,
    { method: 'POST', headers: bearer(token) },
    'complete',
  );
  expect(response.status).toBe(200);
  openSessions.delete(session.id);
  return (await response.json()) as UploadResult;
};
const legacy = async (token: string, bytes: Uint8Array, name: string) => {
  const body = new FormData();
  body.append('file', new File([new Uint8Array(bytes)], name));
  return request(
    '/upload',
    { method: 'POST', headers: bearer(token), body },
    'legacy',
  );
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'miku-stress-'));
  uploads = path.join(directory, 'uploads');
  staging = path.join(directory, 'staging');
  await mkdir(path.join(uploads, 'temp'), { recursive: true });
  await mkdir(staging);
  process.env.TEMP = staging;
  process.env.TMP = staging;
  process.env.TMPDIR = staging;
  process.env.UPLOADS_DIRECTORY = uploads;
  process.env.ZIP_CACHE_DIRECTORY = path.join(directory, 'zip-cache');
  process.env.ADMIN_USERS = '';
  process.env.ADMIN_TOKENS = adminToken;
  process.env.MAX_FILE_SIZE = '8';
  process.env.MAX_TEMP_FILE_SIZE = '12';
  process.env.MAX_BATCH_FILE_SIZE = '16';
  process.env.SHOULD_REDIRECT = 'false';
  process.env.ZIP_CACHE_TTL_SECONDS = '120';
  process.env.ZIP_MAX_CONCURRENT = '8';
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  client = new SQL(
    `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`,
  );
  await client`DROP TABLE IF EXISTS collection_files, collections, files, users CASCADE`;
  await client`CREATE TABLE users (id serial PRIMARY KEY, "user" text NOT NULL UNIQUE, api_key text NOT NULL UNIQUE, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`;
  await client`CREATE TABLE files (id serial PRIMARY KEY, key text NOT NULL UNIQUE, owner_id integer NOT NULL REFERENCES users(id), filename text NOT NULL, size integer NOT NULL, real_filename text NOT NULL DEFAULT '', expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`;
  for (const script of ['migrate-checksums.ts', 'migrate-collections.ts']) {
    const migration = Bun.spawnSync(['bun', 'run', `build-tools/${script}`], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    if (migration.exitCode) throw new Error(migration.stderr.toString());
  }
  const database = await import('../src/db/client');
  await database.createUser(database.db, 'anonymous', 'stress-anonymous');
  for (const owner of owners)
    await database.createUser(database.db, owner, owner);
  const { createApp } = await import('../src/app');
  app = createApp().listen({ port: 0, hostname: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server?.port}`;
});

afterAll(async () => {
  for (const [id, token] of openSessions) {
    await request(`/ui-upload/${id}`, {
      method: 'DELETE',
      headers: bearer(token),
    }).catch(() => undefined);
  }
  if (app) await app.stop();
  if (client) await client.close();
  for (const [name, value] of Object.entries(originalTemp)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('bounded parallel chunk/legacy uploads, downloads, archives, and failed-request cleanup', async () => {
  const payloads = [randomBytes(fileSize), randomBytes(fileSize)];
  const hashes = payloads.map(digest);
  const baselineRSS = process.memoryUsage().rss;
  let peakRSS = baselineRSS;
  const sampler = setInterval(() => {
    peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
  }, 25);
  const monitorState = { running: true };
  const statsFailures: string[] = [];
  const monitor = (async () => {
    while (monitorState.running) {
      try {
        const response = await request(
          '/adminpane/api/stats',
          { headers: bearer(adminToken) },
          'stats',
        );
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      } catch (error) {
        statsFailures.push(
          error instanceof Error ? error.message : String(error),
        );
      }
      await Bun.sleep(50);
    }
  })();
  const start = performance.now();
  const specifications = Array.from({ length: 15 }, (_, index) => ({
    token: owners[index % owners.length]!,
    group: Math.floor(index / owners.length) % payloads.length,
    name: `stress_${index}.bin`,
    chunked: index < 12,
  }));
  const completed = usesNode
    ? await nodeControl(specifications, payloads).catch((error: unknown) => [
        { status: 'rejected' as const, reason: error },
      ])
    : await Promise.allSettled(
        specifications.map(async (spec) => {
          const bytes = payloads[spec.group]!;
          if (spec.chunked) return uploadChunks(spec.token, bytes, spec.name);
          const response = await legacy(spec.token, bytes, spec.name);
          expect(response.status).toBe(200);
          return (await response.json()) as UploadResult;
        }),
      );
  const uploadElapsed = performance.now() - start;
  const failures = completed.flatMap((item, index) =>
    item.status === 'rejected'
      ? [{ name: specifications[index]!.name, error: String(item.reason) }]
      : [],
  );
  if (failures.length)
    console.error('Stress upload failures:', JSON.stringify(failures));
  const results: UploadResult[] = [];
  try {
    for (const item of completed) {
      if (item.status === 'rejected') throw item.reason;
      results.push(item.value);
    }
    expect(results.length).toBe(15);
    const [counts] = await client`SELECT count(*)::int AS count FROM files`;
    expect(counts.count).toBe(15);
    await Promise.all(
      results.map(async (file, index) => {
        const expected = hashes[specifications[index]!.group]!;
        expect(file.sha256).toBe(expected);
        expect(await readFile(file, expected)).toBe(fileSize);
      }),
    );
    const inodeGroups = new Map<string, string>();
    for (const [index, file] of results.entries()) {
      const fileStat = await stat(path.join(uploads, file.filename), {
        bigint: true,
      });
      const inode = `${fileStat.dev}:${fileStat.ino}`;
      const checksum = hashes[specifications[index]!.group]!;
      if (inodeGroups.has(checksum))
        expect(inode).toBe(inodeGroups.get(checksum)!);
      else inodeGroups.set(checksum, inode);
    }
    const stats = (await request('/adminpane/api/stats', {
      headers: bearer(adminToken),
    }).then((response) => response.json())) as {
      logicalBytes: number;
      physicalBytes: number;
      missingFiles: number;
    };
    expect(stats.logicalBytes).toBe(15 * fileSize);
    expect(stats.physicalBytes).toBe(2 * fileSize);
    expect(stats.missingFiles).toBe(0);
    const collectionResponse = await jsonRequest('/collections', owners[0]!, {
      name: 'stress_collection',
      files: [results[0]!.key, results[4]!.key],
    });
    expect(collectionResponse.status).toBe(201);
    const collection = (await collectionResponse.json()) as { key: string };
    const info = (await request(`/collections/${collection.key}/info`).then(
      (response) => response.json(),
    )) as CollectionInfo;
    const load = [
      ...results
        .slice(0, 3)
        .map((file, index) =>
          readFile(file, hashes[specifications[index]!.group]!),
        ),
      ...Array.from({ length: 2 }, async () => {
        const start = performance.now();
        const response = await request(info.zip, {}, 'zip');
        expect(response.status).toBe(200);
        const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
        observe('zip_body', performance.now() - start);
        expect(Object.keys(archive).sort()).toEqual([
          'stress_0.bin',
          'stress_4.bin',
        ]);
        expect(digest(archive['stress_0.bin']!)).toBe(hashes[0]!);
        expect(digest(archive['stress_4.bin']!)).toBe(hashes[1]!);
      }),
      ...Array.from({ length: 12 }, async (_, index) => {
        const response = await request(
          `/qrcode?text=${encodeURIComponent(base + '/' + results[index]!.key)}&v=2`,
          {},
          'qr',
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('<svg');
      }),
    ];
    await Promise.all(load);
    const [selected] =
      await client`SELECT id FROM files WHERE key=${results[0]!.key}`;
    expect(
      (
        await request(`/adminpane/api/files/${selected.id}`, {
          method: 'DELETE',
          headers: bearer(adminToken),
        })
      ).status,
    ).toBe(200);
    expect((await request(info.zip)).status).toBe(410);
    expect((await request('/' + results[0]!.key)).status).toBe(404);
    const sameBytes = results[8]!;
    expect(await readFile(sameBytes, hashes[0]!)).toBe(fileSize);
    const current = (await request(`/collections/${collection.key}/info`).then(
      (response) => response.json(),
    )) as CollectionInfo;
    expect(current.zip).not.toBe(info.zip);
    expect((await request(current.zip, { method: 'HEAD' })).status).toBe(200);
    const beforeFailures =
      await client`SELECT count(*)::int AS count FROM files`;
    const oversized = await legacy(
      owners[0]!,
      new Uint8Array(8 * MiB + 1),
      'oversized.bin',
    );
    expect(oversized.status).toBe(413);
    expect(
      (
        await jsonRequest('/ui-upload', 'invalid-token', {
          files: [{ name: 'x.bin', size: 1 }],
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await jsonRequest('/ui-upload', owners[0]!, {
          files: [{ name: 'x.bin', size: 8 * MiB + 1 }],
        })
      ).status,
    ).toBe(413);
    const invalid = await Promise.all(
      Array.from({ length: 8 }, () =>
        jsonRequest('/ui-upload', owners[0]!, { files: 'invalid' }),
      ),
    );
    invalid.forEach((response) => expect(response.status).toBe(400));
    const sessions = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        startSession(owners[0]!, 1, `retry_${index}.bin`),
      ),
    );
    expect(
      (
        await jsonRequest('/ui-upload', owners[0]!, {
          files: [{ name: 'extra.bin', size: 1 }],
        })
      ).status,
    ).toBe(429);
    const retry = sessions[0]!;
    expect(
      (
        await request(`/ui-upload/${retry.id}/0/0`, {
          method: 'PUT',
          headers: bearer('invalid-token'),
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(`/ui-upload/${retry.id}/0/0`, {
          method: 'PUT',
          headers: bearer(owners[1]!),
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/ui-upload/${retry.id}/complete`, {
          method: 'POST',
          headers: bearer(owners[0]!),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/ui-upload/${retry.id}/0/0`, {
          method: 'PUT',
          headers: bearer(owners[0]!),
          body: new Uint8Array([1, 2]),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request(`/ui-upload/${retry.id}/0/0`, {
          method: 'PUT',
          headers: bearer(owners[0]!),
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(204);
    const overflowStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    expect(
      (
        await request(`/ui-upload/${retry.id}/0/0`, {
          method: 'PUT',
          headers: bearer(owners[0]!),
          body: overflowStream,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request(`/ui-upload/${retry.id}/0/0`, {
          method: 'PUT',
          headers: bearer(owners[0]!),
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(204);
    // A failed write released its lock. Discarding now removes all staging and creates no DB row.
    await Promise.all(sessions.map((session) => discard(session, owners[0]!)));
    const next = await startSession(owners[0]!, 1, 'after_failures.bin');
    await discard(next, owners[0]!);
    const afterFailures =
      await client`SELECT count(*)::int AS count FROM files`;
    expect(afterFailures[0].count).toBe(beforeFailures[0].count);
    expect(
      (await readdir(staging)).filter(
        (name) =>
          name.startsWith('miku-chunks-') || name.startsWith('miku-multipart-'),
      ),
    ).toEqual([]);
    expect(
      (await readdir(uploads)).filter(
        (name) => name.includes('.deleted-') || name.endsWith('.part'),
      ),
    ).toEqual([]);
    expect(openSessions.size).toBe(0);
    expect(statsFailures).toEqual([]);
  } finally {
    monitorState.running = false;
    await monitor;
    clearInterval(sampler);
  }
  const report = Object.fromEntries(
    [...metrics].map(([kind, values]) => {
      const sorted = [...values].sort((left, right) => left - right);
      return [
        kind,
        {
          requests: sorted.length,
          p95_ms: Number(
            sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(2),
          ),
        },
      ];
    }),
  );
  console.info(
    `Local stress measurements (Bun server/verification client RSS; upload transport ${usesNode ? 'external Node' : 'Bun fetch'}; not production capacity):`,
    JSON.stringify({
      uploadedMiB: 90,
      uploadSeconds: Number((uploadElapsed / 1000).toFixed(3)),
      uploadMiBPerSecond: Number((90 / (uploadElapsed / 1000)).toFixed(2)),
      rssBaselineMiB: Number((baselineRSS / MiB).toFixed(1)),
      rssPeakMiB: Number((peakRSS / MiB).toFixed(1)),
      nodeClientRSS,
      responseStatuses: Object.fromEntries(statuses),
      latency: report,
    }),
  );
}, 180_000);
