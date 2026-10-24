import { startServer } from './lib/server.ts';
import { logStats } from './lib/stats.ts';

const abortController = new AbortController();
let shuttingDown = false;

const shutdown = () => {
    if (!shuttingDown) {
        shuttingDown = true;
        abortController.abort();
        setTimeout(() => process.exit(), 1000);
    }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(logStats, 5 * 60 * 1000).unref();

await startServer({
    signal: abortController.signal,
});
