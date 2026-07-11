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
        config = Config.loadConfig(Deno.env.toObject());
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        Deno.exit(1);
    }

    await Paths.ensureDataDirs(config.dataDir);
    const db = new Db(Paths.dbPath(config.dataDir));
    const app = App.buildApp({ config, db });

    const worker = Worker.startWorker({ db, config });
    const stopRetention = Retention.startRetentionJob(db, config);

    const server = Deno.serve({ port: config.port }, app.fetch);
    const artifactCrawler = ArtifactCrawler.startArtifactCrawler({
        db,
        config,
    });
    Log.logEvent('server_started', {
        port: config.port,
        data_dir: config.dataDir,
    });

    const shutdown = async () => {
        Log.logEvent('server_stopping');
        stopRetention();
        await artifactCrawler.stop();
        await server.shutdown();
        await worker.stop();
        db.close();
        Deno.exit(0);
    };
    Deno.addSignalListener('SIGINT', shutdown);
    Deno.addSignalListener('SIGTERM', shutdown);
}
