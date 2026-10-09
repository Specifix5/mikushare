import { Elysia } from 'elysia';
import { z } from 'zod';
import { db, getUserFromKey, withTransaction } from './db/client';
import { getAccessKey } from './utils/helpers';
import { addCollection, readCollection } from './utils/collections';
import { collectionZip } from './utils/zip';
import { BASE_URL, FILES_URL, MAX_UPLOAD_FILES } from './utils/constants';
import { isPreviewImage, withEmbedMetadata } from './utils/embeds';
import { readJsonObject } from './utils/json-body';

const noCache = {
  'Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
};
const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  files: z.array(z.string().min(1).max(64)).min(1).max(MAX_UPLOAD_FILES),
});

const archiveHandler = async ({
  params,
  request,
}: {
  params: { key: string };
  request: Request;
}) => {
  const revision = new URL(request.url).searchParams.get('rev');
  if (!revision || !/^[a-f0-9]{64}$/.test(revision)) {
    return new Response(
      'A valid ZIP revision is required. Open the collection for its download link.',
      { status: 400, headers: noCache },
    );
  }
  const collection = await readCollection(params.key);
  if (!collection)
    return new Response('Collection not found', {
      status: 404,
      headers: noCache,
    });
  if (
    revision !== collection.revision ||
    !collection.members.some((file) => file.available)
  ) {
    return new Response(
      'This ZIP revision is no longer available. Open the collection for the current revision.',
      { status: 410, headers: noCache },
    );
  }
  return collectionZip(collection, request);
};

export const collectionRoutes = () =>
  new Elysia({ prefix: '/collections' })
    .post(
      '',
      async ({ request }) => {
        const token = getAccessKey(request);
        const user = token ? await getUserFromKey(db, token) : null;
        if (!user) return new Response('Unauthorized', { status: 401 });
        const parsed = createSchema.safeParse(await readJsonObject(request));
        if (!parsed.success)
          return new Response('Enter a collection name and file keys', {
            status: 400,
          });
        try {
          const collection = await withTransaction((tx) =>
            addCollection(tx, user.id, parsed.data.files, parsed.data.name),
          );
          return Response.json(collection, { status: 201, headers: noCache });
        } catch {
          return new Response('Collections can contain only your own files', {
            status: 400,
          });
        }
      },
      { parse: 'none' },
    )
    .get('/:key', async ({ params }) => {
      const collection = await readCollection(params.key);
      if (!collection)
        return new Response('Collection not found', {
          status: 404,
          headers: noCache,
        });
      const preview = collection.members.find(
        (file) => file.available && isPreviewImage(file.filename),
      );
      const available = collection.members.filter((file) => file.available);
      const totalBytes = available.reduce((sum, file) => sum + file.size, 0);
      const description = `${available.length} of ${collection.members.length} files available · ${(totalBytes / 1024 / 1024).toFixed(2)} MB · Uploaded ${collection.createdAt.toISOString()}`;
      const html = withEmbedMetadata(
        await Bun.file('dist/pages/collection.html').text(),
        {
          title: collection.name,
          description,
          url: `${BASE_URL}/collections/${collection.key}`,
          image: preview
            ? `${FILES_URL}/uploads/${preview.expiresAt ? 'temp/' : ''}${preview.filename}?fn=${encodeURIComponent(preview.name)}&v=3`
            : undefined,
        },
      );
      return new Response(html, {
        headers: { ...noCache, 'Content-Type': 'text/html; charset=utf-8' },
      });
    })
    .get('/:key/info', async ({ params }) => {
      const collection = await readCollection(params.key);
      if (!collection)
        return new Response('Collection not found', {
          status: 404,
          headers: noCache,
        });
      return Response.json(
        {
          name: collection.name,
          key: collection.key,
          url: `${BASE_URL}/collections/${collection.key}`,
          createdAt: collection.createdAt,
          zip: collection.members.some((file) => file.available)
            ? `${BASE_URL}/collections/${collection.key}/download.zip?rev=${collection.revision}`
            : null,
          files: collection.members.map((file) => ({
            key: file.key,
            name: file.name,
            size: file.size,
            sha256: file.sha256,
            available: file.available,
            createdAt: file.uploadedAt,
            expiresAt: file.expiresAt,
            shareUrl: `${BASE_URL}/${file.key}`,
            url: `${BASE_URL}/${file.key}?download=1`,
          })),
        },
        { headers: noCache },
      );
    })
    .get('/:key/download.zip', archiveHandler)
    .head('/:key/download.zip', archiveHandler);
