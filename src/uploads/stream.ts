import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import busboy from 'busboy';
import {
  MAX_BATCH_FILE_SIZE,
  MAX_FILE_SIZE,
  MAX_TEMP_FILE_SIZE,
  MAX_UPLOAD_FILES,
} from '../config/constants';

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// Cancel the original request reader as soon as a downstream limit fails.
export function requestStream(request: Request) {
  const reader = request.body?.getReader();
  return new Readable({
    read() {
      if (!reader) {
        this.destroy(new UploadError('Missing request body'));
        return;
      }
      void reader.read().then(
        ({ done, value }) => {
          this.push(done ? null : value);
        },
        (error: Error) => this.destroy(error),
      );
    },
    destroy(error, callback) {
      if (!reader) {
        callback(error);
        return;
      }
      void reader.cancel(error).then(
        () => {
          reader.releaseLock();
          callback(error);
        },
        () => callback(error),
      );
    },
  });
}

export function byteLimit(
  maxBytes: number,
  message: string,
  expected?: number,
) {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > maxBytes ? new UploadError(message, 413) : null, chunk);
    },
    flush(callback) {
      callback(
        expected !== undefined && size !== expected
          ? new UploadError('Incomplete chunk')
          : null,
      );
    },
  });
}

export function multipartWireLimit(boundarySize = 200) {
  // Busboy caps each part header at 16 KiB; bound text fields and delimiters too.
  const framing =
    (MAX_UPLOAD_FILES + 8) * (16 * 1024 + boundarySize + 8) +
    8 * 4096 +
    boundarySize +
    8;
  return Math.floor(MAX_BATCH_FILE_SIZE * 1024 * 1024) + framing;
}

export async function parseUpload(request: Request) {
  const type = request.headers.get('content-type') ?? '';
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  const boundarySize = Buffer.byteLength(boundary?.[1] ?? boundary?.[2] ?? '');
  if (
    !type.toLowerCase().startsWith('multipart/form-data') ||
    !boundarySize ||
    boundarySize > 200
  )
    throw new UploadError('Invalid multipart boundary');
  // Multipart framing is bounded separately from actual file bytes. Busboy caps
  // each part header at 16 KiB; at most eight small text fields are accepted.
  const wireLimit = multipartWireLimit(boundarySize);
  const length = Number(request.headers.get('content-length'));
  if (length > wireLimit)
    throw new UploadError('Max upload size exceeded', 413);
  const uploads: { name: string; filepath: string; size: number }[] = [];
  const fields = new Map<string, string>();
  const tasks: Promise<void>[] = [];
  const streams: Readable[] = [];
  let total = 0;
  let failure: Error | undefined;
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { 'content-type': type },
      defParamCharset: 'utf8',
      limits: {
        files: MAX_UPLOAD_FILES,
        fields: 8,
        parts: MAX_UPLOAD_FILES + 8,
        fieldSize: 4096,
      },
    });
  } catch {
    throw new UploadError('Invalid multipart form data');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'miku-multipart-'));
  const fail = (error: Error) => {
    failure ??= error;
    parser.destroy(error);
    for (const stream of streams) stream.destroy(error);
  };
  const limit = () =>
    fields.has('ttl') && Number(fields.get('ttl'))
      ? MAX_TEMP_FILE_SIZE
      : fields.has('ttl')
        ? MAX_FILE_SIZE
        : Math.max(MAX_FILE_SIZE, MAX_TEMP_FILE_SIZE);
  parser.on('file', (field, stream, metadata) => {
    streams.push(stream);
    stream.on('error', (error: Error) => {
      failure ??= error;
      parser.destroy(error);
    });
    if (field !== 'file') {
      fail(new UploadError('Unexpected file field'));
      stream.resume();
      return;
    }
    const filepath = path.join(directory, String(uploads.length));
    const entry = { name: metadata.filename, filepath, size: 0 };
    uploads.push(entry);
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        entry.size += chunk.length;
        total += chunk.length;
        const error =
          entry.size > limit() * 1024 * 1024
            ? new UploadError(`Max per file is ${limit()} MB`, 413)
            : total > MAX_BATCH_FILE_SIZE * 1024 * 1024
              ? new UploadError(`Max total is ${MAX_BATCH_FILE_SIZE} MB`, 413)
              : null;
        callback(error, chunk);
      },
    });
    tasks.push(
      pipeline(stream, counter, createWriteStream(filepath)).catch(fail),
    );
  });
  parser.on('field', (name, value, metadata) => {
    if (metadata.valueTruncated || fields.has(name)) {
      fail(new UploadError('Invalid form field'));
      return;
    }
    fields.set(name, value);
    if (
      name === 'ttl' &&
      (!Number.isFinite(Number(value)) ||
        Number(value) < 1 ||
        Number(value) > 168)
    )
      fail(new UploadError('TTL must be between 1 and 168 hours'));
    if (name === 'collectionName' && value.length > 150)
      fail(new UploadError('Invalid collection name'));
    if (uploads.some((file) => file.size > limit() * 1024 * 1024))
      fail(new UploadError(`Max per file is ${limit()} MB`, 413));
  });
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const)
    parser.on(event, () => fail(new UploadError('Too many multipart parts')));
  try {
    await pipeline(
      requestStream(request),
      byteLimit(wireLimit, 'Max upload size exceeded'),
      parser,
    );
    await Promise.all(tasks);
    if (failure) throw failure;
    if (!uploads.length) throw new UploadError('Choose at least one file');
    const ttl = fields.has('ttl') ? Number(fields.get('ttl')) : undefined;
    const finalLimit = ttl ? MAX_TEMP_FILE_SIZE : MAX_FILE_SIZE;
    if (uploads.some((file) => file.size > finalLimit * 1024 * 1024))
      throw new UploadError(`Max per file is ${finalLimit} MB`, 413);
    // Refresh BunFile metadata after streaming writers have closed.
    return {
      uploads: uploads.map((file) => ({
        name: file.name,
        blob: Bun.file(file.filepath),
      })),
      ttl,
      collectionName: fields.get('collectionName'),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    for (const stream of streams) stream.destroy();
    await Promise.all(tasks);
    await rm(directory, { recursive: true, force: true });
    const reason = failure ?? error;
    throw reason instanceof UploadError
      ? reason
      : new UploadError('Invalid multipart form data');
  }
}
