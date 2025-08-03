import { readFile } from 'fs/promises';
import { getFile, withTransaction } from './db/client';
import { SHOULD_REDIRECT, UPLOADS_DIR } from './utils/constants';
import { readdir } from 'fs/promises';
import path from 'path';
import { file } from 'bun';

export const GetFileHandler = async ({
  params,
}: {
  params: { id: string };
}) => {
  const { id } = params;
  const fileMetadata = await withTransaction(async (tx) => {
    return await getFile(tx, id);
  });
  if (!fileMetadata) return new Response('Not Found', { status: 404 });

  if (SHOULD_REDIRECT) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/uploads/${fileMetadata.filename}` },
    });
  }

  const buffer = await readFile(path.join(UPLOADS_DIR, fileMetadata.filename));
  const mime = file(fileMetadata.filename).type || 'application/octet-stream';
  return new Response(new Uint8Array(buffer), {
    headers: { 'Content-Type': mime },
  });
};
