import { writeFile } from 'fs/promises';
import path, { extname } from 'path';
import { CheckIfKeyValid } from './utils/helpers';
import {
  BASE_URL,
  MAX_FILE_SIZE,
  MAX_TEMP_FILE_SIZE,
  UPLOADS_DIR,
} from './utils/constants';
import { addFile, getUserFromKey, withTransaction } from './db/client';
import { FileCreateError, UserNotFoundError } from './db/errors';
import { info } from './cli';

export const UploadHandler = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const accessKey = url.searchParams.get('key');

  if (!accessKey || !(await CheckIfKeyValid(accessKey))) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Get form data
  const formData = await request.formData();
  const file = formData.get('file') as File;
  const rawTTL = formData.get('ttl');
  const ttl = Number(rawTTL);
  if (rawTTL && (isNaN(ttl) || ttl < 1 || ttl > 24 * 7)) {
    return new Response(
      'Invalid TTL, must be a number between 1 and ' + 7 * 24,
      { status: 400 },
    );
  }

  if (!file)
    return new Response(
      'No file uploaded, pass "file" parameter as form data',
      { status: 400 },
    );

  // Non-Temp Files Limit
  if (!ttl && file.size > MAX_FILE_SIZE * 1024 * 1024) {
    return new Response(
      `File too large (Max ${MAX_FILE_SIZE} MB, up to ${MAX_TEMP_FILE_SIZE} for temp uploads)`,
      { status: 413 },
    );
  }

  // Temp Files Limit
  if (ttl && file.size > MAX_TEMP_FILE_SIZE * 1024 * 1024) {
    return new Response(
      `File too large (Max ${MAX_FILE_SIZE} MB, up to ${MAX_TEMP_FILE_SIZE} for temp uploads)`,
      { status: 413 },
    );
  }

  const { key, filename } = await withTransaction(async (tx) => {
    const user = await getUserFromKey(tx, accessKey);

    if (!user) {
      throw new UserNotFoundError(accessKey);
    }

    const ext = extname(file.name) || '.png';

    let fileMetadata;

    try {
      fileMetadata = await addFile(
        tx,
        user.id,
        ext,
        file.size,
        ttl ? new Date(Date.now() + ttl * 60 * 60 * 1000) : undefined,
      );
    } catch (e) {
      throw new FileCreateError(e instanceof Error ? e : undefined);
    }

    const filePath = path.join(
      UPLOADS_DIR,
      !!ttl ? './temp' : './',
      `./${fileMetadata.filename}`,
    );

    info(
      `FileUploads${!!ttl ? '/Temp' : ''}`,
      `${user.user} - Attempting to save ${file.name} as ${fileMetadata.key} to: ${filePath}`,
    );

    // Save file
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buf);

    return fileMetadata;
  });

  const urlOut = `${BASE_URL}/${key}`;
  return new Response(
    JSON.stringify({ url: urlOut, filename: filename, isTemp: !!ttl }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
};
