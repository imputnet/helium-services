import { getConnInfo } from '@hono/node-server/conninfo';
import { bearerAuth } from 'hono/bearer-auth';
import { rateLimiter } from 'hono-rate-limiter';
import { type Context, Hono } from 'hono';

import { logError, logEvent } from '../log.ts';
import type { AppDeps, Env } from '../app.ts';
import { HttpError, ingestLog, readBody } from '../ingest.ts';
import { hashNames, parseNameList } from '../names.ts';

function clientIp(c: Context<Env>): string {
    const xff = c.req.header('x-forwarded-for');

    if (xff) {
        return xff.split(',')[0].trim();
    }

    const address = getConnInfo(c).remote.address;

    if (!address) {
        throw new Error('no peer address on connection');
    }

    return address;
}

export function ingestRoutes(deps: AppDeps): Hono<Env> {
    const { config, db, allowlist } = deps;
    const allow = allowlist ? (hash: bigint) => allowlist.has(hash) : undefined;
    const app = new Hono<Env>();

    app.get('/healthz', (c) => c.json({ ok: true }));

    // Chromium only treats 200 as success, retries everything except 400,
    // and ignores the response body.
    app.post(
        '/uma/v2',
        rateLimiter<Env>({
            windowMs: 60_000,
            limit: config.rateLimitPerMinute,
            standardHeaders: 'draft-6',
            keyGenerator: (c) => clientIp(c),
        }),
        async (c) => {
            try {
                const { result, histograms, bytes } = await ingestLog(
                    c.req.raw,
                    db,
                    config.maxLogSizeBytes,
                    { allow },
                );

                logEvent('log_received', { result, histograms, bytes });

                return c.text('ok');
            } catch (err) {
                if (err instanceof HttpError) {
                    logEvent('log_rejected', {
                        status: err.status,
                        reason: err.message,
                    });

                    return c.text(`${err.message}\n`, err.status);
                }

                logError('log_ingest_error', err);

                return c.text('internal error\n', 500);
            }
        },
    );

    const authError = { ok: false, error: 'missing or invalid bearer token' };
    app.post(
        '/api/histogram-names',
        bearerAuth<Env>({
            token: config.namesUploadToken,
            noAuthenticationHeader: { message: authError },
            invalidAuthenticationHeader: { message: authError },
            invalidToken: { message: authError },
        }),
        async (c) => {
            try {
                const body = await readBody(
                    c.req.raw,
                    config.maxNamesSizeBytes,
                );

                const names = parseNameList(new TextDecoder().decode(body));
                const imported = db.upsertNames(hashNames(names));
                logEvent('names_imported', { imported });

                return c.json({ ok: true, imported, total: db.nameCount() });
            } catch (err) {
                if (err instanceof HttpError) {
                    return c.json(
                        { ok: false, error: err.message },
                        err.status,
                    );
                }

                logError('names_import_error', err);

                return c.json({ ok: false, error: 'internal error' }, 500);
            }
        },
    );

    return app;
}
