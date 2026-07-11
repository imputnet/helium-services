import { Hono } from 'hono';

import type { Db } from './db.ts';
import type { Config } from './config.ts';
import type { SessionPayload } from './session.ts';
import * as Auth from './routes/auth.ts';
import * as Ingest from './routes/ingest.ts';
import * as Web from './routes/web.ts';

export interface AppDeps {
    config: Config;
    db: Db;
    githubFetch?: typeof fetch;
    symsorterBin?: string;
}

export type Env = {
    Variables: {
        session: SessionPayload;
        token: { token: string; expires_in?: number } | undefined;
        'user-github': { login?: string } | undefined;
    };
};

export function buildApp(deps: AppDeps): Hono<Env> {
    const app = new Hono<Env>();

    app.route('/', Ingest.ingestRoutes(deps));
    app.route('/', Auth.authRoutes(deps));
    app.route('/', Web.webRoutes(deps));

    return app;
}
