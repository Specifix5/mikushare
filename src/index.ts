import { env } from './utils/env';
import { init_db } from './db/client';
import { PORT } from './utils/constants';
import { info, init_cli } from './cli';
import { init_cleanup } from './utils/cleanup';
import { createApp } from './app';

await init_db();
const app = createApp().listen(PORT);
info('Main', 'Server is running on http://localhost:' + app.server?.port);
init_cli();
if (env.INIT_CLEANUP) init_cleanup();
