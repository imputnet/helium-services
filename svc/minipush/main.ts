import { startServer } from './lib/server.ts';
import { logStats } from './lib/stats.ts';

const abortController = new AbortController();
let shuttingDown = false;

const shutdown = () => {
    if (!shuttingDown) {
        shuttingDown = true;
        abortController.abort();
        setTimeout(() => Deno.exit(), 1000);
    }
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
