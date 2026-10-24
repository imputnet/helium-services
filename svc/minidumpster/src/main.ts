import { serve } from '@hono/node-server';

import * as App from './app.ts';
import * as ArtifactCrawler from './artifact-crawler.ts';
import * as Config from './config.ts';
import * as Log from './log.ts';
import * as Paths from './paths.ts';
import * as Retention from './retention.ts';
import * as Worker from './worker.ts';
import { Db } from './db.ts';

if (import.meta.main) {
    let config;
    try {
        config = Config.loadConfig(process.env);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    await Paths.ensureDataDirs(config.dataDir);
    const db = new Db(Paths.dbPath(config.dataDir));
    const app = App.buildApp({ config, db });

    const stopRetention = Retention.startRetentionJob(db, config);
    const worker = Worker.startWorker({ db, config });

    const server = serve({ fetch: app.fetch, port: config.port });
    const artifactCrawler = ArtifactCrawler.startArtifactCrawler({
        db,
        config,
    });
    Log.logEvent('server_started', {
        port: config.port,
        data_dir: config.dataDir,
    });

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        Log.logEvent('server_stopping');
        stopRetention();
        await artifactCrawler.stop();
        await new Promise((resolve) => server.close(resolve));
        await worker.stop();
        db.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
