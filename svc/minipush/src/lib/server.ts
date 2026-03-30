import { env } from './env.ts';
import * as UA from './ua/server.ts';
import * as Webpush from './webpush/server.ts';

import { Hono } from '@hono/hono';
import { getConnInfo } from '@hono/hono/deno';
import { rateLimiter } from '@hono-rate-limiter/hono-rate-limiter';

type ServerParameters = {
    signal: AbortSignal;
};

export const startServer = async (params: ServerParameters) => {
    const app = new Hono();

    app.use(rateLimiter({
        windowMs: env.rateLimitWindowMs,
        limit: env.rateLimit,
        standardHeaders: 'draft-6',
        keyGenerator: (c) => getConnInfo(c).remote.address || '',
    }));

    app.get('/', (c) => {
        return UA.handleWebsocketSetup(c.req.raw);
    });

    const WPUSH = new URLPattern({ pathname: '/wpush/:version/:token' });
    app.post(WPUSH.pathname, (c) => {
        const match = WPUSH.exec(c.req.url)!;
        return Webpush.handleWebPushRequest(c.req.raw, match);
    });

    const MESSAGE = new URLPattern({ pathname: '/m/:id' });
    app.delete(MESSAGE.pathname, (c) => {
        const match = MESSAGE.exec(c.req.url)!;
        return Webpush.handleWebPushDeletion(c.req.raw, match);
    });

    const server = Deno.serve({
        hostname: env.bindHostname,
        port: env.port,
        signal: params.signal,
    }, app.fetch);

    console.log(env);

    await server.finished;
};
