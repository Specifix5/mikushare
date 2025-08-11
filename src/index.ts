import 'dotenv/config';
import { init_db } from './db/client';
import { PORT, SHOULD_REDIRECT } from './utils/constants';
import { Elysia } from 'elysia';
import { render } from './utils/render';
import staticPlugin from '@elysiajs/static';
import { UploadHandler } from './upload';
import { info, init_cli } from './cli';
import { GetFileHandler, GetFileUploads } from './getFile';
import { init_cleanup } from './utils/cleanup';

const app = new Elysia()
  .use(staticPlugin({ assets: 'dist/public' }))
  //.use(staticPlugin({ assets: 'dist/public/favicon.ico' }))
  .post('/upload', UploadHandler)
  .get('/', async () => {
    const html = await render('index');
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  })
  .get('/:id', GetFileHandler)
  .get('/favicon.ico', () => {
    return new Response(null, {
      headers: {
        Location: '/public/favicon.ico',
      },
      status: 302,
    });
  });

if (!SHOULD_REDIRECT) {
  app.get('/uploads/:id', GetFileUploads);
  app.get('/uploads/temp/:id', async ({ params }) => {
    return GetFileUploads({ params, temp: true });
  });
}

app.listen(PORT);

info('Main', 'Server is running on http://localhost:' + PORT);

init_cli();
await init_db();
if (process.env.INIT_CLEANUP !== 'false') init_cleanup();
