import { Elysia } from 'elysia';
import { sql } from 'drizzle-orm';
import { db, getUserFromKey } from '../db/client';
import { BASE_URL } from '../config/constants';

const headers = {
  'Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  Vary: 'Authorization',
};
const reject = (message: string, status: number) =>
  new Response(message, { status, headers });
// History deliberately accepts bearer headers only; never put account tokens in URLs.
const identity = (request: Request) => {
  const token = /^Bearer\s+(\S{1,512})$/i.exec(
    request.headers.get('authorization') ?? '',
  )?.[1];
  return token ? getUserFromKey(db, token) : Promise.resolve(null);
};
export const accountRoutes = () =>
  new Elysia({ prefix: '/account' })
    .onError(() => reject('Unable to load previous files', 500))
    .get(
      '/history',
      () => new Response(Bun.file('dist/pages/history.html'), { headers }),
    )
    .get('/info', async ({ request }) => {
      const user = await identity(request);
      if (!user) return reject('Invalid or expired token', 401);
      return Response.json(
        { public: user.public || user.user === 'anonymous' },
        { headers },
      );
    })
    .get('/files', async ({ request }) => {
      const user = await identity(request);
      if (!user) return reject('Invalid or expired token', 401);
      if (user.public || user.user === 'anonymous')
        return reject(
          'Previous files are unavailable for public accounts',
          403,
        );
      const offset = Number(
        new URL(request.url).searchParams.get('offset') ?? 0,
      );
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
        return reject('Invalid offset', 400);
      const result = await db.execute<{
        kind: 'collection' | 'file';
        key: string;
        name: string;
        createdAt: Date;
        expiresAt: Date | null;
        size: string | number;
        count: number;
      }>(sql`
      SELECT * FROM (
        SELECT 'collection' AS kind, c.key, c.name, c.created_at AS "createdAt",
          NULL::timestamptz AS "expiresAt", COALESCE(sum(cf.size), 0)::bigint AS size,
          count(cf.file_key)::integer AS count
        FROM collections c LEFT JOIN collection_files cf ON cf.collection_key = c.key
        WHERE c.owner_id = ${user.id}
        GROUP BY c.key
        UNION ALL
        SELECT 'file' AS kind, f.key, COALESCE(f.paste_title, NULLIF(f.real_filename, ''), f.filename) AS name,
          f.created_at AS "createdAt", f.expires_at AS "expiresAt", f.size::bigint AS size, 1 AS count
        FROM files f WHERE f.owner_id = ${user.id}
          AND (f.expires_at IS NULL OR f.expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM collection_files cf JOIN collections c ON c.key = cf.collection_key
            WHERE cf.file_id = f.id AND c.owner_id = ${user.id})
      ) entries ORDER BY "createdAt" DESC, kind, key LIMIT 51 OFFSET ${offset}
    `);
      const entries = (
        Array.from(result) as {
          kind: 'collection' | 'file';
          key: string;
          name: string;
          createdAt: Date;
          expiresAt: Date | null;
          size: string | number;
          count: number;
        }[]
      )
        .slice(0, 50)
        .map((row) => ({
          kind: row.kind,
          key: row.key,
          name: row.name,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          size: Number(row.size),
          count: Number(row.count),
          url: `${BASE_URL}/${row.kind === 'collection' ? 'collections/' : ''}${encodeURIComponent(String(row.key))}`,
          downloadUrl:
            row.kind === 'file'
              ? `${BASE_URL}/${encodeURIComponent(String(row.key))}?download=1`
              : null,
        }));
      return Response.json(
        { entries, hasMore: result.length > 50 },
        { headers },
      );
    });
