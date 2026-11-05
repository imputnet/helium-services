import { startServer } from './lib/server.ts';
import { logStats } from './lib/stats.ts';
import { drain } from './lib/drain.ts';
import { env } from './lib/env.ts';

const abortController = new AbortController();
let shuttingDown = false;

const shutdown = async () => {
    if (shuttingDown) {
        Deno.exit(1);
    }

    shuttingDown = true;
    setTimeout(() => {
        console.error('draining took too long, exiting anyway');
        Deno.exit(1);
    }, (env.ackGraceMs + env.drainSeconds * 1000) + 10_000);

    await drain();
    abortController.abort();
    Deno.exit();
};

globalThis.addEventListener('error', (e) => {
    e.preventDefault();
    console.error('uncaught error:', e.error);
});
globalThis.addEventListener('unhandledrejection', (e) => {
    e.preventDefault();
    console.error('unhandled rejection:', e.reason);
});

Deno.addSignalListener('SIGINT', shutdown);
Deno.addSignalListener('SIGTERM', shutdown);
Deno.unrefTimer(setInterval(logStats, 5 * 60 * 1000));

await startServer({
    signal: abortController.signal,
});
