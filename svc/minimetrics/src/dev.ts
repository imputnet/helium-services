import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';

import * as App from './app.ts';
import { devConfig } from './config.ts';
import { logEvent } from './log.ts';
import { Db } from './db.ts';
import { startMaintenanceJob } from './retention.ts';

const config = devConfig(process.env);

await mkdir(config.dataDir, { recursive: true });

const db = new Db(join(config.dataDir, 'db.sqlite'));

const app = App.buildApp({
    config,
    db,
    webAuth: async (c, next) => {
        c.set('session', { login: 'dev', exp: Number.MAX_SAFE_INTEGER });
        await next();
    },
});

startMaintenanceJob(db, config);

serve({ fetch: app.fetch, port: config.port });

logEvent('dev_server_started', {
    url: config.publicBaseUrl,
    data_dir: config.dataDir,
    names_token: config.namesUploadToken,
});
