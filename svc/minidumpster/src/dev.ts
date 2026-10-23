import { serve } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';

import * as App from './app.ts';
import { devConfig } from './config.ts';
import { seedDevData } from './dev-seed.ts';
import { Db } from './db.ts';
import * as Paths from './paths.ts';

if (import.meta.main) {
    const config = devConfig(process.env);
    await Paths.ensureDataDirs(config.dataDir);
    const db = new Db(Paths.dbPath(config.dataDir));
    const seeded = await seedDevData(db, config);
    const mockAuth: MiddlewareHandler<App.Env> = async (c, next) => {
        c.set('session', {
            login: 'local-dev',
            exp: Date.now() + 24 * 60 * 60 * 1000,
        });
        await next();
    };
    const app = App.buildApp({ config, db, webAuth: mockAuth });
    const server = serve({ fetch: app.fetch, port: config.port });

    console.log(
        `mock dev server: ${config.publicBaseUrl} `
            + `(${seeded.reportsCreated} new, ${seeded.reportsTotal} total reports; `
            + `data: ${config.dataDir})`,
    );

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        await new Promise((resolve) => server.close(resolve));
        db.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
