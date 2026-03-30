import { startServer } from './lib/server.ts';

const abortController = new AbortController();
let shuttingDown = false;

const shutdown = () => {
    if (!shuttingDown) {
        shuttingDown = true;
        abortController.abort();
        setTimeout(() => Deno.exit(), 1000);
    }
};

Deno.addSignalListener('SIGINT', shutdown);
Deno.addSignalListener('SIGTERM', shutdown);

await startServer({
    signal: abortController.signal,
});
