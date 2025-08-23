import 'dotenv/config';
import { init_db } from './db/client';
import { MAX_TEMP_FILE_SIZE, PORT } from './utils/constants';
import { Elysia } from 'elysia';
import { render } from './utils/render';
import staticPlugin from '@elysiajs/static';
import { UploadHandler } from './upload';
import { info, init_cli } from './cli';
import { GetFileHandler, GetFileUploads } from './getFile';
import { init_cleanup } from './utils/cleanup';
import { handleAuth } from './utils/helpers';
import { qrCodeHandler } from './qrcode';

const _ = new Elysia({
  serve: {
    maxRequestBodySize: 1024 * 1024 * (MAX_TEMP_FILE_SIZE + 5),
  },
})
  .use(staticPlugin({ assets: 'dist/public' }))
  .post('/upload', UploadHandler, {
    beforeHandle({ request }: { request: Request }) {
      return handleAuth(request);
    },
  })
  .options(
    '/upload',
    () =>
      new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      }),
  )
  .get('/', async () => {
    const html = await render('index');
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  })
  .get('/:id', GetFileHandler)
  .get('/qrcode', qrCodeHandler)
  .get('/uploads/:id', GetFileUploads)
  .get('/uploads/temp/:id', async ({ params, request }) => {
    return GetFileUploads({ params, temp: true, request });
  })
  .get('/favicon.ico', () => {
    return new Response(null, {
      headers: {
        Location: '/public/favicon.ico',
      },
      status: 302,
    });
  })
  .listen(PORT);

info('Main', 'Server is running on http://localhost:' + PORT);

init_cli();
await init_db();
if (process.env.INIT_CLEANUP !== 'false') init_cleanup();
