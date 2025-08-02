import { UPLOADS_DIR } from './utils/constants';
import { readdir } from 'fs/promises';

export const getFile = async ({ params }: { params: { id: string } }) => {
  const { id } = params;
  const dir = UPLOADS_DIR;

  const files = await readdir(dir);
  const file = files.find((f) => f.startsWith(id));
  if (!file) return new Response('Not Found', { status: 404 });

  return new Response(null, {
    status: 302,
    headers: { Location: `/uploads/${file}` },
  });
};
