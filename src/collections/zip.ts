import { Zip, ZipDeflate } from 'fflate';
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import type { Collection } from './service';
import { contentDisposition } from '../files/filenames';
import { isStoredFile } from '../files/storage';

const pending = new Map<string, Promise<void>>();
let activeGenerators = 0;
const cacheDirectory = () => path.resolve(env.ZIP_CACHE_DIRECTORY);

export const zipTTL = (collection: Collection): number =>
  collection.members
    .filter((file) => file.available)
    .reduce((ttl, file) => {
      return file.expiresAt
        ? Math.min(
            ttl,
            Math.max(
              0,
              Math.floor((file.expiresAt.getTime() - Date.now()) / 1000),
            ),
          )
        : ttl;
    }, env.ZIP_CACHE_TTL_SECONDS);

const pruneCache = async () => {
  const directory = cacheDirectory();
  await mkdir(directory, { recursive: true });
  const entries = [];
  for (const name of await readdir(directory)) {
    // Only remove our own generated archives, never unrelated files.
    if (!/^[a-f0-9]{64}\.zip$/.test(name)) continue;
    const filepath = path.join(directory, name);
    try {
      entries.push({ filepath, stat: await stat(filepath) });
    } catch {
      /* Concurrent pruning. */
    }
  }
  entries.sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
  let total = entries.reduce((size, entry) => size + entry.stat.size, 0);
  for (const entry of entries) {
    if (
      Date.now() - entry.stat.mtimeMs >= env.ZIP_CACHE_TTL_SECONDS * 1000 ||
      total > env.ZIP_CACHE_MAX_MB * 1024 * 1024
    ) {
      await unlink(entry.filepath).catch(() => undefined);
      total -= entry.stat.size;
    }
  }
};

async function* generateZip(
  collection: Collection,
  signal: AbortSignal,
  cachePath: string | null,
) {
  const output: Uint8Array[] = [];
  const zip = new Zip((error, data) => {
    if (error) throw error;
    output.push(data);
  });
  let handle: FileHandle | null = null;
  let temporary: string | null = null;
  let completed = false;
  let written = 0;
  try {
    if (cachePath) {
      temporary = cachePath + '.' + randomUUID() + '.part';
      try {
        handle = await open(temporary, 'wx');
      } catch {
        temporary = null;
      }
    }
    const flush = async function* () {
      while (output.length) {
        const chunk = output.shift()!;
        if (handle) {
          written += chunk.byteLength;
          if (written > env.ZIP_CACHE_MAX_MB * 1024 * 1024) {
            await handle.close();
            handle = null;
            if (temporary) await unlink(temporary);
            temporary = null;
          } else {
            try {
              await handle.writeFile(chunk);
            } catch {
              await handle.close().catch(() => undefined);
              handle = null;
              if (temporary) await unlink(temporary).catch(() => undefined);
              temporary = null;
            }
          }
        }
        yield chunk;
      }
    };
    for (const file of collection.members.filter(
      (member) => member.available,
    )) {
      if (signal.aborted) throw new Error('ZIP download cancelled');
      // Recheck immediately before opening: availability may change while the
      // request waits for a cache writer. Fail rather than silently omit a file.
      if (!(await isStoredFile(file.filepath)))
        throw new Error('Collection source is no longer available');
      const entry = new ZipDeflate(file.name, { level: 6 });
      // Stable metadata also keeps independently generated archives consistent.
      entry.mtime = new Date('2000-01-01T00:00:00Z');
      zip.add(entry);
      const reader = Bun.file(file.filepath).stream().getReader();
      try {
        while (true) {
          if (signal.aborted) throw new Error('ZIP download cancelled');
          const { value, done } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.length; offset += 65536) {
            entry.push(value.subarray(offset, offset + 65536));
            yield* flush();
          }
        }
        entry.push(new Uint8Array(), true);
        yield* flush();
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    zip.end();
    yield* flush();
    if (handle && temporary && cachePath) {
      await handle.close();
      handle = null;
      await rename(temporary, cachePath);
      temporary = null;
      await pruneCache().catch(() => undefined);
    }
    completed = true;
  } finally {
    if (!completed) zip.terminate();
    if (handle) await handle.close();
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}

export const collectionZip = async (
  collection: Collection,
  request: Request,
): Promise<Response> => {
  const ttl = zipTTL(collection);
  const etag = `"${collection.revision}"`;
  const policy = ttl ? `public, max-age=${ttl}, must-revalidate` : 'no-store';
  const headers = {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(collection.name + '.zip', true),
    'Cache-Control': policy,
    'CDN-Cache-Control': policy,
    'Cloudflare-CDN-Cache-Control': policy,
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
  };
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  if (request.method === 'HEAD') return new Response(null, { headers });
  const cachePath = path.join(cacheDirectory(), collection.revision + '.zip');
  let cacheEnabled = ttl > 0;
  if (ttl) {
    try {
      await pruneCache();
      await pending.get(cachePath);
      const cached = await stat(cachePath).catch(() => null);
      if (
        cached &&
        Date.now() - cached.mtimeMs < env.ZIP_CACHE_TTL_SECONDS * 1000
      ) {
        return new Response(Bun.file(cachePath), {
          headers: { ...headers, 'X-Zip-Cache': 'HIT' },
        });
      }
    } catch {
      // A cache failure should not prevent downloading the collection.
      cacheEnabled = false;
    }
  }
  let finish: (() => void) | undefined;
  // Recheck after asynchronous cache reads, then claim the generation slot
  // without another await so simultaneous misses share a single writer.
  if (cacheEnabled && pending.has(cachePath)) {
    await pending.get(cachePath);
    return collectionZip(collection, request);
  }
  // Cache hits and HEAD requests returned above. Reserve without awaiting so
  // simultaneous misses cannot exceed the process-wide compression bound.
  if (activeGenerators >= env.ZIP_MAX_CONCURRENT)
    return new Response('Too many ZIP downloads; try again shortly.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
    });
  activeGenerators++;
  if (cacheEnabled)
    pending.set(
      cachePath,
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
  const iterator = generateZip(
    collection,
    request.signal,
    cacheEnabled ? cachePath : null,
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeGenerators--;
    request.signal.removeEventListener('abort', abort);
    if (cacheEnabled) pending.delete(cachePath);
    finish?.();
  };
  const abort = () => {
    void iterator
      .return()
      .catch(() => undefined)
      .finally(release);
  };
  request.signal.addEventListener('abort', abort, { once: true });
  // The signal can become aborted while awaiting cache IO/pending generation.
  // Registering a listener after that event does not invoke it automatically.
  if (request.signal.aborted) abort();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          release();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel() {
      try {
        await iterator.return();
      } finally {
        release();
      }
    },
  });
  return new Response(stream, {
    headers: { ...headers, 'X-Zip-Cache': 'MISS' },
  });
};
