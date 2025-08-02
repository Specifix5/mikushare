import 'dotenv/config';
import { PORT, UPLOADS_DIR } from './utils/constants';
import { Elysia } from 'elysia';
import { render } from './utils/render';
import staticPlugin from '@elysiajs/static';
import { upload } from './upload';
import { init_cli } from './cli';
import { readdir } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { getFile } from './getFile';

if (!existsSync(UPLOADS_DIR)) {
  console.log('Creating uploads directory');
  mkdirSync(UPLOADS_DIR);
}

const app = new Elysia()
  .use(staticPlugin({ assets: 'dist/public' }))
  .post('/upload', upload)
  .get('/', async () => {
    const html = await render('index');
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  })
  .get('/:id', getFile)
  .listen(PORT);

console.log('Server is running on http://localhost:' + PORT);
init_cli();
