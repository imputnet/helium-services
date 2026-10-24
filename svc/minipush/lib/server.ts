import { env } from './env.ts';
import * as UA from './ua/server.ts';
import * as Webpush from './webpush/server.ts';
import * as Mesh from './mesh/mesh.ts';
import { handleFrame } from './mesh/dispatch.ts';

import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { rateLimiter } from 'hono-rate-limiter';
import { WebSocketServer } from 'ws';

type ServerParameters = {
    signal: AbortSignal;
};

type Bindings = { incoming: IncomingMessage; acceptUpgrade?: () => void };

const toRequest = (req: IncomingMessage) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        for (const v of [value ?? []].flat()) {
            headers.append(name, v);
        }
    }

    const target = req.url ?? '';
    const url = target.startsWith('/') ? `http://localhost${target}` : target;
    return new Request(url, {
        method: req.method,
        headers,
    });
};

export const startServer = async (params: ServerParameters) => {
    Mesh.setHandler(handleFrame);
    const app = new Hono<{ Bindings: Bindings }>();
    const wss = new WebSocketServer({
        noServer: true,
        verifyClient: async ({ req }, done) => {
            let accepted = false;
            let status = 400;
            try {
                const res = await app.fetch(toRequest(req), {
                    incoming: req,
                    acceptUpgrade: () => {
                        accepted = true;
                    },
                });
                status = res.status;
            } catch {
                // toRequest() throws on request targets that aren't valid urls
            }

            done(accepted, status);
        },
    });

    app.use(
        rateLimiter({
            windowMs: env.rateLimitWindowMs,
            limit: env.rateLimit,
            standardHeaders: 'draft-6',
            keyGenerator: (c) => getConnInfo(c).remote.address || '',
        }),
    );

    app.get('/', (c) => {
        return UA.handleWebsocketSetup(c.req.raw, c.env.acceptUpgrade);
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

    const server = serve({
        fetch: app.fetch,
        hostname: env.bindHostname,
        port: env.port,
    });

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) =>
        wss.handleUpgrade(req, socket, head, UA.handleWebsocketConnection),
    );
    params.signal.addEventListener('abort', () => server.close());

    env.log();
    await once(server, 'close');
};
