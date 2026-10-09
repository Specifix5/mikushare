import { Elysia } from 'elysia';
import staticPlugin from '@elysiajs/static';
import { UploadHandler } from './upload';
import { GetFileHandler, GetFileUploads } from './getFile';
import { handleAuth } from './utils/helpers';
import { qrCodeHandler } from './qrcode';
import { adminRoutes } from './admin';
import { collectionRoutes } from './collections';
import { textRoutes } from './texts';
import { CHUNK_SIZE, chunkRoutes } from './chunk-upload';
import { multipartWireLimit } from './utils/upload-stream';
import { errorPage, wantsErrorPage } from './utils/error-pages';

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
    .use(staticPlugin({ assets: 'dist/public' }))
    .get(
      '/favicon.ico',
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: '/public/favicon.ico' },
        }),
    )
    .get('/', () => Bun.file('dist/pages/index.html'))
    .use(adminRoutes())
    .use(collectionRoutes())
    .use(textRoutes())
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
