import 'dotenv/config';
import { init_db } from './db/client';
import { PORT } from './utils/constants';
import { Elysia } from 'elysia';
import { render } from './utils/render';
import staticPlugin from '@elysiajs/static';
import { UploadHandler } from './upload';
import { info, init_cli } from './cli';
import { GetFileHandler } from './getFile';
import { init_cleanup } from './utils/cleanup';

const _app = new Elysia()
  .use(staticPlugin({ assets: 'dist/public' }))
  .post('/upload', UploadHandler)
  .get('/', async () => {
    const html = await render('index');
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  })
  .get('/:id', GetFileHandler)
  .listen(PORT);

info('Main', 'Server is running on http://localhost:' + PORT);

init_cli();
await init_db();
if (process.env.INIT_CLEANUP !== 'false') init_cleanup();
