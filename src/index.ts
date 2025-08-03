import 'dotenv/config';
import { db, init_db } from './db/client';
import { PORT, UPLOADS_DIR } from './utils/constants';
import { Elysia } from 'elysia';
import { render } from './utils/render';
import staticPlugin from '@elysiajs/static';
import { UploadHandler } from './upload';
import { info, init_cli } from './cli';
import { existsSync, mkdirSync } from 'fs';
import { GetFileHandler } from './getFile';

if (!existsSync(UPLOADS_DIR)) {
  info('Main', 'Creating uploads directory');
  mkdirSync(UPLOADS_DIR);
}

const app = new Elysia()
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
init_db();
