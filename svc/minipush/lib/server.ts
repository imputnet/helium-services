import { env } from './env.ts';
import * as UA from './ua/server.ts';
import * as Webpush from './webpush/server.ts';
import * as Mesh from './mesh/mesh.ts';
import { handleFrame } from './mesh/dispatch.ts';

import { Hono } from '@hono/hono';
import { getConnInfo } from '@hono/hono/deno';
import type { Context } from '@hono/hono';
import { RateLimiter } from './util/ratelimit.ts';
import * as HTTP from './util/http.ts';

type ServerParameters = {
    signal: AbortSignal;
};

export const startServer = async (params: ServerParameters) => {
    Mesh.setHandler(handleFrame);
    const app = new Hono();

    const connectLimiter = new RateLimiter(
        env.rateLimitConnectsPerIp,
        env.rateLimitWindowMs,
    );

    const clientAddress = (c: Context) => {
        const forwarded = c.req.header('x-forwarded-for');
        if (env.trustProxy && forwarded) {
            // Only the last address was added by our proxy.
            return forwarded.split(',').at(-1)!.trim();
        }

        return getConnInfo(c).remote.address || '';
    };

    app.get('/', (c) => {
        if (!connectLimiter.take(clientAddress(c))) {
            return new Response(null, {
                status: HTTP.status.TOO_MANY_REQUESTS,
                headers: {
                    'Retry-After': String(
                        Math.ceil(env.rateLimitWindowMs / 1000),
                    ),
                },
            });
        }

        return UA.handleWebsocketSetup(c.req.raw);
    });

    app.get('/healthcheck', () => {
        return new Response(null, { status: 204 });
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

    env.log();
    await server.finished;
};
