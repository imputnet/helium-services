import { getConnInfo } from 'hono/deno';
import { rateLimiter } from 'hono-rate-limiter';
import { type Context, Hono } from 'hono';

import { logError, logEvent } from '../log.ts';
import type { AppDeps, Env } from '../app.ts';
import { ingestSymbolUpload } from '../symbols.ts';
import { dumpPath, writeFileWithDirs } from '../paths.ts';
import { HttpError, parseCrashRequest } from '../crash.ts';
import { symbolicatorReachable } from '../symbolicator.ts';

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

function errorText(err: HttpError): Response {
    return new Response(`${err.message}\n`, {
        status: err.status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
}

function errorJson(err: HttpError): Response {
    return Response.json({ ok: false, error: err.message }, {
        status: err.status,
    });
}

export function ingestRoutes(deps: AppDeps): Hono<Env> {
    const { config, db } = deps;
    const app = new Hono<Env>();

    app.get('/healthz', async (c) => {
        const symbolicator = await symbolicatorReachable(
            config.symbolicatorUrl,
        );
        return c.json({ ok: true, symbolicator });
    });

    app.post(
        '/crash',
        rateLimiter<Env>({
            windowMs: 60_000,
            limit: config.rateLimitPerMinute,
            standardHeaders: 'draft-6',
            keyGenerator: (c) => clientIp(c),
        }),
        async (c) => {
            try {
                const { dump, annotations } = await parseCrashRequest(
                    c.req.raw,
                    config.maxDumpSizeBytes,
                );

                const id = crypto.randomUUID();
                await writeFileWithDirs(dumpPath(config.dataDir, id), dump);

                db.insertReport({
                    id,
                    product: annotations['prod'] ?? null,
                    version: annotations['ver'] ?? null,
                    guid: annotations['guid'] ?? null,
                    ptype: annotations['ptype'] ?? null,
                    channel: annotations['channel'] ?? null,
                    annotations: JSON.stringify(annotations),
                    received_at: Date.now(),
                });

                logEvent('report_received', {
                    report_id: id,
                    product: annotations['prod'] ?? null,
                    version: annotations['ver'] ?? null,
                    ptype: annotations['ptype'] ?? null,
                    channel: annotations['channel'] ?? null,
                    dump_bytes: dump.byteLength,
                });

                // Crashpad expects the bare report id as the response body.
                return c.text(id);
            } catch (err) {
                if (err instanceof HttpError) {
                    return errorText(err);
                }

                logError('crash_ingest_error', err);
                return c.text('internal error\n', 500);
            }
        },
    );

    app.post('/api/symbols', async (c) => {
        try {
            const result = await ingestSymbolUpload(c.req.raw, config, db, {
                symsorterBin: deps.symsorterBin,
            });
            return c.json(result);
        } catch (err) {
            if (err instanceof HttpError) {
                return errorJson(err);
            }

            logError('symbols_ingest_error', err);
            return c.json({ ok: false, error: 'internal error' }, 500);
        }
    });

    return app;
}
