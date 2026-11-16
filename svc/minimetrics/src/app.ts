import { Hono, type MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import type { Db } from './db.ts';
import type { Config } from './config.ts';
import type { SessionPayload } from './session.ts';
import * as Auth from './routes/auth.ts';
import * as Ingest from './routes/ingest.ts';
import * as Web from './routes/web.ts';

export interface AppDeps {
    config: Config;
    db: Db;
    allowlist?: Set<bigint>;
    githubFetch?: typeof fetch;
    webAuth?: MiddlewareHandler<Env>;
}

export type Env = {
    Variables: {
        session: SessionPayload;
        token: { token: string; expires_in?: number } | undefined;
        'user-github': { login?: string } | undefined;
    };
};

function securityHeaders(config: Config): MiddlewareHandler<Env> {
    return secureHeaders({
        contentSecurityPolicy: {
            defaultSrc: ["'none'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'"],
            formAction: ["'self'"],
            baseUri: ["'none'"],
            frameAncestors: ["'none'"],
        },
        strictTransportSecurity: config.publicBaseUrl.startsWith('https://')
            ? 'max-age=63072000; includeSubDomains'
            : false,
        xFrameOptions: 'DENY',
    });
}

export function buildApp(deps: AppDeps): Hono<Env> {
    const app = new Hono<Env>();

    app.use('*', securityHeaders(deps.config));
    app.use('/auth/*', async (c, next) => {
        await next();
        c.header('cache-control', 'no-store');
    });

    app.route('/', Ingest.ingestRoutes(deps));
    app.route('/', Auth.authRoutes(deps));
    app.route('/', Web.webRoutes(deps));

    return app;
}
