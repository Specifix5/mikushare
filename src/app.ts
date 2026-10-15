import { accountRoutes } from './accounts/routes';
import { Elysia } from 'elysia';
import staticPlugin from '@elysiajs/static';
import { UploadHandler } from './uploads/routes';
import { GetFileHandler, GetFileUploads } from './files/routes';
import { handleAuth } from './core/helpers';
import { qrCodeHandler } from './sharing/qrcode';
import { adminRoutes } from './admin/routes';
import { collectionRoutes } from './collections/routes';
import { textRoutes } from './texts/routes';
import { filePageRoutes } from './files/pages';
import { CHUNK_SIZE, chunkRoutes } from './uploads/chunks';
import { multipartWireLimit } from './uploads/stream';
import { errorPage, wantsErrorPage } from './core/error-pages';
import { pdfAssetRoutes } from './pdf/assets';

export const createApp = () =>
  new Elysia({
    serve: {
      maxRequestBodySize: Math.max(multipartWireLimit(), CHUNK_SIZE),
      idleTimeout: 120,
    },
  })
    .onError({ as: 'global' }, ({ code, request }) => {
      if (code === 'NOT_FOUND' && wantsErrorPage(request))
        return errorPage(404);
      if (code === 'UNKNOWN' || code === 'INTERNAL_SERVER_ERROR') {
        if (wantsErrorPage(request)) return errorPage(500);
        return new Response('Internal Server Error', {
          status: 500,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
    })
    .onAfterHandle({ as: 'global' }, ({ request, response }) => {
      if (
        wantsErrorPage(request) &&
        response instanceof Response &&
        (response.status === 404 || response.status === 500)
      )
        return errorPage(response.status);
    })
    .use(pdfAssetRoutes())
    .use(
      staticPlugin({
        assets: 'dist/public',
        ignorePatterns: ['.DS_Store', '.git', '.env', /[\\/]pdf[\\/]/],
      }),
    )
    .get(
      '/favicon.ico',
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: '/public/favicon.ico' },
        }),
    )
    .get('/', () => Bun.file('dist/pages/index.html'))
    .use(accountRoutes())
    .use(adminRoutes())
    .use(collectionRoutes())
    .use(textRoutes())
    .use(filePageRoutes())
    .use(chunkRoutes())
    .post('/upload', UploadHandler, {
      parse: 'none',
      beforeHandle: ({ request }) => handleAuth(request),
    })
    .options(
      '/upload',
      () =>
        new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          },
        }),
    )
    .get('/qrcode', qrCodeHandler)
    .get('/uploads/:id', GetFileUploads)
    .get('/uploads/temp/:id', ({ params, request }) =>
      GetFileUploads({ params, temp: true, request }),
    )
    .get('/:id', GetFileHandler);
