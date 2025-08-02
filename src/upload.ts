import { randomBytes } from 'crypto';
import { writeFile } from 'fs/promises';
import path, { extname } from 'path';
import { CheckIfKeyValid } from './utils/keys';
import { BASE_URL, UPLOADS_DIR } from './utils/constants';

export const upload = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!(await CheckIfKeyValid(key || ''))) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Get form data
  const formData = await request.formData();
  const file = formData.get('file') as File;

  if (!file) return new Response('No file uploaded', { status: 400 });

  if (file.size > 64 * 1024 * 1024) {
    return new Response('File too large (max 64MB)', { status: 413 });
  }

  // Random ID
  const id = randomBytes(6).toString('base64url');
  const ext = extname(file.name) || '.png';
  const filePath = path.join(UPLOADS_DIR, `./${id}${ext}`);

  console.log(`Attempting to save ${file.name} as ${id}${ext} to: ${filePath}`);

  // Save file
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buf);

  const urlOut = `${BASE_URL}/${id}`;
  return new Response(JSON.stringify({ url: urlOut }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
