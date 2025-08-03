import { randomBytes } from 'crypto';
import { writeFile } from 'fs/promises';
import path, { extname } from 'path';
import { CheckIfKeyValid } from './utils/keys';
import { BASE_URL, UPLOADS_DIR } from './utils/constants';
import { addFile, getUserFromKey, withTransaction } from './db/client';
import { FileCreateError, UserNotFoundError } from './db/errors';
import { error } from './cli';

export const UploadHandler = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const accessKey = url.searchParams.get('key');

  if (!accessKey || !(await CheckIfKeyValid(accessKey))) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Get form data
  const formData = await request.formData();
  const file = formData.get('file') as File;

  if (!file) return new Response('No file uploaded', { status: 400 });

  if (file.size > 64 * 1024 * 1024) {
    return new Response('File too large (max 64MB)', { status: 413 });
  }

  const { key } = await withTransaction(async (tx) => {
    const user = await getUserFromKey(tx, accessKey);

    if (!user) {
      throw new UserNotFoundError(key);
    }

    const ext = extname(file.name) || '.png';
    const fileMetadata = await addFile(tx, user.id, ext, file.size);

    if (!fileMetadata) {
      throw new FileCreateError();
    }

    const filePath = path.join(UPLOADS_DIR, `./${fileMetadata.filename}`);

    console.log(
      `Attempting to save ${file.name} as ${fileMetadata.key} to: ${filePath}`,
    );

    // Save file
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buf);

    return fileMetadata;
  });

  const urlOut = `${BASE_URL}/${key}`;
  return new Response(JSON.stringify({ url: urlOut }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
