import { Elysia } from 'elysia';
import { desc, eq, sql } from 'drizzle-orm';
import { createUser, db, getUser, withTransaction } from '../db/client';
import { files, users } from '../db/schema';
import {
  adminFromToken,
  allowLogin,
  endAdminSession,
  getAdmin,
  sameOrigin,
  startAdminSession,
} from './auth';
import { removeAccount, rotateKey } from '../accounts/service';
import { removeFile } from '../files/service';
import { BASE_URL } from '../config/constants';
import { info } from '../accounts/commands';
import { readJsonObject } from '../core/json-body';
import { env } from '../config/env';
import {
  cleanupFilter,
  executeCleanup,
  previewCleanup,
  storageStats,
} from './storage';

const privateHeaders = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const reject = (message: string, status = 400) =>
  new Response(message, { status, headers: privateHeaders });
const readBody = readJsonObject;

export const adminRoutes = () =>
  new Elysia({ prefix: '/adminpane' })
    .onError(() => reject('Unable to complete the admin request', 500))
    .get(
      '/login',
      () =>
        new Response(Bun.file('dist/pages/admin-login.html'), {
          headers: privateHeaders,
        }),
    )
    .post(
      '/session',
      async ({ request, server }) => {
        if (!sameOrigin(request)) return reject('Forbidden', 403);
        if (!allowLogin(server?.requestIP(request)?.address ?? 'local'))
          return reject(
            'Too many login attempts. Try again in 15 minutes.',
            429,
          );
        const body = await readBody(request);
        if (!body || typeof body.token !== 'string')
          return reject('Enter an admin token');
        const identity = await adminFromToken(body.token);
        if (!identity)
          return reject('Invalid or unauthorized admin token', 401);
        info('Admin', `${identity.user} signed in`);
        return Response.json(
          { ok: true },
          {
            headers: {
              ...privateHeaders,
              'Set-Cookie': startAdminSession(identity, request),
            },
          },
        );
      },
      { parse: 'none' },
    )
    .guard(
      {
        beforeHandle: async ({ request }) => {
          if (await getAdmin(request)) return;
          if (
            new URL(request.url).pathname === '/adminpane' &&
            request.method === 'GET'
          ) {
            return new Response(null, {
              status: 302,
              headers: { ...privateHeaders, Location: '/adminpane/login' },
            });
          }
          return reject('Unauthorized', 401);
        },
      },
      (app) =>
        app
          .get(
            '',
            () =>
              new Response(Bun.file('dist/pages/admin.html'), {
                headers: privateHeaders,
              }),
          )
          .delete(
            '/session',
            ({ request }) =>
              Response.json(
                { ok: true },
                {
                  headers: {
                    ...privateHeaders,
                    'Set-Cookie': endAdminSession(request),
                  },
                },
              ),
            { parse: 'none' },
          )
          .get('/api/stats', async () =>
            Response.json(await storageStats(), { headers: privateHeaders }),
          )
          .post(
            '/api/files/preview',
            async ({ request }) => {
              const parsed = cleanupFilter.safeParse(await readBody(request));
              if (!parsed.success)
                return reject(
                  'Invalid cleanup filters: choose an owner, positive age, or valid date range',
                );
              const identity = await getAdmin(request);
              if (!identity) return reject('Unauthorized', 401);
              const preview = await previewCleanup(identity.token, parsed.data);
              if (!preview)
                return reject(
                  'Too many pending previews; try again in five minutes',
                  429,
                );
              return Response.json(preview, { headers: privateHeaders });
            },
            { parse: 'none' },
          )
          .post(
            '/api/files/delete',
            async ({ request }) => {
              const body = await readBody(request);
              if (!body || typeof body.previewId !== 'string')
                return reject('A deletion preview is required');
              const identity = await getAdmin(request);
              if (!identity) return reject('Unauthorized', 401);
              const result = await executeCleanup(
                identity.token,
                body.previewId,
              );
              if (!result)
                return reject(
                  'Preview expired or already used; preview the files again',
                  409,
                );
              info(
                'Admin',
                `Cleanup: ${result.deleted} deleted, ${result.skipped} skipped, ${result.failed} failed`,
              );
              return Response.json(result, { headers: privateHeaders });
            },
            { parse: 'none' },
          )
          .get('/api/users', async () => {
            const result = await db
              .select({
                id: users.id,
                user: users.user,
                public: users.public,
                expiresAt: users.expiresAt,
                createdAt: users.createdAt,
              })
              .from(users)
              .orderBy(users.id);
            return Response.json(result, { headers: privateHeaders });
          })
          .post(
            '/api/users',
            async ({ request }) => {
              const body = await readBody(request);
              if (
                !body ||
                typeof body.user !== 'string' ||
                !/^[a-zA-Z0-9_-]{1,64}$/.test(body.user)
              ) {
                return reject(
                  'Username must be 1–64 letters, numbers, underscores or hyphens',
                );
              }
              if (body.public !== undefined && typeof body.public !== 'boolean')
                return reject('Public must be a boolean');
              if (body.token !== undefined && typeof body.token !== 'string')
                return reject('Token must be a string');
              let token = body.token?.trim();
              if (token === '') token = undefined;
              if (token && !/^[!-~]{1,512}$/.test(token))
                return reject(
                  'Token must be 1–512 ASCII characters without spaces',
                );
              if (token && env.ADMIN_TOKENS.includes(token))
                return reject('Token is already reserved for an admin', 409);
              if (
                body.expiresAt !== undefined &&
                body.expiresAt !== null &&
                typeof body.expiresAt !== 'string'
              ) {
                return reject('Expiry must be a date string');
              }
              const expiresAt = body.expiresAt
                ? new Date(body.expiresAt)
                : undefined;
              if (
                expiresAt &&
                (!Number.isFinite(expiresAt.getTime()) ||
                  expiresAt <= new Date())
              ) {
                return reject('Expiry must be a future date');
              }
              let result;
              try {
                result = await withTransaction(async (tx) => {
                  if (await getUser(tx, body.user as string)) return null;
                  return createUser(
                    tx,
                    body.user as string,
                    token,
                    expiresAt,
                    body.public === true,
                  );
                });
              } catch (failure) {
                const error = failure as {
                  code?: string;
                  errno?: string;
                  cause?: { code?: string; errno?: string };
                };
                if (
                  [
                    error.code,
                    error.errno,
                    error.cause?.code,
                    error.cause?.errno,
                  ].includes('23505')
                )
                  return reject('Username or token already exists', 409);
                throw failure;
              }
              if (!result) return reject('Username already exists', 409);
              info('Admin', `Created account ${result.user}`);
              return Response.json(
                {
                  id: result.id,
                  user: result.user,
                  public: result.public,
                  token: result.apiKey,
                  expiresAt: result.expiresAt,
                },
                { status: 201, headers: privateHeaders },
              );
            },
            { parse: 'none' },
          )
          .patch(
            '/api/users/:user',
            async ({ params, request }) => {
              const body = await readBody(request);
              if (!body || typeof body.public !== 'boolean')
                return reject('Public must be a boolean');
              if (params.user === 'anonymous' && !body.public)
                return reject('Anonymous must remain public');
              const [account] = await db
                .update(users)
                .set({ public: body.public })
                .where(eq(users.user, params.user))
                .returning({ user: users.user, public: users.public });
              if (!account) return reject('Account not found', 404);
              return Response.json(account, { headers: privateHeaders });
            },
            { parse: 'none' },
          )
          .post(
            '/api/users/:user/rotate',
            async ({ params }) => {
              const token = await rotateKey(params.user);
              if (!token) return reject('Account not found', 404);
              info('Admin', `Rotated token for ${params.user}`);
              return Response.json({ token }, { headers: privateHeaders });
            },
            { parse: 'none' },
          )
          .delete(
            '/api/users/:user',
            async ({ params, request }) => {
              if (params.user === 'anonymous')
                return reject('Cannot delete the anonymous account');
              const identity = await getAdmin(request);
              if (identity?.account && identity.user === params.user)
                return reject(
                  'Cannot delete the account you are signed in with',
                );
              if (!(await removeAccount(params.user)))
                return reject('Account not found', 404);
              info(
                'Admin',
                `Deleted ${params.user}; files transferred to anonymous`,
              );
              return Response.json({ ok: true }, { headers: privateHeaders });
            },
            { parse: 'none' },
          )
          .get('/api/files', async ({ request }) => {
            const offset = Number(
              new URL(request.url).searchParams.get('offset') ?? 0,
            );
            if (!Number.isSafeInteger(offset) || offset < 0)
              return reject('Invalid offset');
            const result = await db
              .select({
                id: files.id,
                key: files.key,
                filename: files.realFilename,
                owner: users.user,
                size: files.size,
                sha256: files.sha256,
                expiresAt: files.expiresAt,
                createdAt: files.createdAt,
              })
              .from(files)
              .innerJoin(users, eq(files.ownerId, users.id))
              .orderBy(desc(files.id))
              .limit(100)
              .offset(offset);
            const [count] = await db
              .select({ total: sql<number>`count(*)::int` })
              .from(files);
            return Response.json(
              {
                files: result.map((file) => ({
                  ...file,
                  url: `${BASE_URL}/${file.key}`,
                })),
                total: count?.total ?? 0,
              },
              { headers: privateHeaders },
            );
          })
          .delete(
            '/api/files/:id',
            async ({ params }) => {
              const id = Number(params.id);
              if (!Number.isSafeInteger(id) || id < 1)
                return reject('Invalid file ID');
              if (!(await removeFile(id))) return reject('File not found', 404);
              info('Admin', `Deleted file #${id}`);
              return Response.json({ ok: true }, { headers: privateHeaders });
            },
            { parse: 'none' },
          ),
    );
