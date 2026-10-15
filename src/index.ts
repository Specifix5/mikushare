import { env } from './config/env';
import { init_db } from './db/client';
import { PORT } from './config/constants';
import { info, init_cli } from './accounts/commands';
import { init_cleanup } from './core/cleanup';
import { createApp } from './app';

await init_db();
const app = createApp().listen(PORT);
info('Main', 'Server is running on http://localhost:' + app.server?.port);
init_cli();
if (env.INIT_CLEANUP) init_cleanup();
