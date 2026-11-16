import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';

import * as App from './app.ts';
import * as Config from './config.ts';
import * as Log from './log.ts';
import * as Retention from './retention.ts';
import { Db } from './db.ts';
import { loadAllowlist } from './names.ts';

if (import.meta.main) {
    let config;

    try {
        config = Config.loadConfig(process.env);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    await mkdir(config.dataDir, { recursive: true });
    const db = new Db(join(config.dataDir, 'db.sqlite'));

    const allowlist = config.histogramAllowlist
        ? await loadAllowlist(config.histogramAllowlist)
        : undefined;

    const app = App.buildApp({ config, db, allowlist });

    const stopMaintenance = Retention.startMaintenanceJob(db, config);
    const server = serve({ fetch: app.fetch, port: config.port });
    Log.logEvent('server_started', {
        port: config.port,
        data_dir: config.dataDir,
        allowlisted_histograms: allowlist?.size ?? null,
    });

    let shuttingDown = false;

    const shutdown = () => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        Log.logEvent('server_stopping');
        stopMaintenance();
        server.close(() => {
            db.close();
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
