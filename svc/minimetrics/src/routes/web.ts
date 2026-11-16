import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { csrf } from 'hono/csrf';
import { serveStatic } from '@hono/node-server/serve-static';

import * as ui from '../ui.ts';
import { requireSession } from './auth.ts';
import type { AppDeps, Env } from '../app.ts';
import { dayOf, type Filter } from '../db.ts';
import { hashFromHex, hashToHex } from '../names.ts';
import { approxMean, isEnumLike, summarize } from '../stats.ts';
import {
    chooseVersions,
    compareBuckets,
    mergeChanges,
    mixShift,
    rankChanges,
    type VersionChoice,
} from '../compare.ts';

const FILTER_KEYS = ['version', 'channel', 'os', 'arch'] as const;

const disablePrivateResponseCaching: MiddlewareHandler<Env> = async (
    c,
    next,
) => {
    await next();
    c.header('cache-control', 'private, no-store');
};

function pageContext(
    c: Context<Env>,
    deps: AppDeps,
    section?: ui.PageContext['section'],
): ui.PageContext {
    const requested = Number(c.req.query('days'));

    const days = ui.RANGES.find((d) => d === requested) ?? 7;

    const filter: Filter = { fromDay: dayOf(Date.now()) - days + 1 };

    for (const key of FILTER_KEYS) {
        const value = c.req.query(key);

        if (value) {
            filter[key] = value;
        }
    }

    const current = new URL(c.req.url).searchParams;

    const query = (over: Record<string, string | null> = {}) => {
        const params = new URLSearchParams(current);

        for (const [k, v] of Object.entries(over)) {
            if (v === null) {
                params.delete(k);
            } else {
                params.set(k, v);
            }
        }

        const s = new URLSearchParams(
            [...params].filter(([, v]) => v !== ''),
        ).toString();

        return s ? `?${s}` : '';
    };

    return {
        user: c.get('session')?.login,
        section,
        filter,
        days,
        options: deps.db.segmentOptions(filter.fromDay),
        query,
    };
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
    const out = new Map<K, T[]>();

    for (const item of items) {
        const k = key(item);
        out.set(k, [...(out.get(k) ?? []), item]);
    }

    return out;
}

function shares(m: Map<string, number>) {
    const total = [...m.values()].reduce((n, x) => n + x, 0);

    return (value: string) => (m.get(value) ?? 0) / total;
}

function peak(values: Iterable<number>): number {
    return Math.max(0, ...values);
}

export function webRoutes(deps: AppDeps): Hono<Env> {
    const { config, db } = deps;
    const app = new Hono<Env>();
    const k = config.minUsers;
    const peakUsers = (filter: Filter) => peak(db.dailyUsers(filter).values());

    const versionChoice = (c: Context<Env>, filter: Filter): VersionChoice => {
        const choice = chooseVersions(
            db.versionUsage(filter),
            filter.channel,
            (version) => peakUsers({ ...filter, version }) >= k,
        );

        const a = c.req.query('a');
        const b = c.req.query('b');

        if (
            a && b && a !== b && choice.versions.includes(a)
            && choice.versions.includes(b)
        ) {
            choice.pair = [a, b];
        }

        return choice;
    };

    app.use('/static/*', serveStatic({ root: './src' }));
    app.use('*', deps.webAuth ?? requireSession(config));
    app.use('*', disablePrivateResponseCaching);
    app.use('*', csrf({ origin: config.publicBaseUrl }));

    app.get('/', (c) => {
        const ctx = pageContext(c, deps, 'overview');
        const users = db.dailyUsers(ctx.filter);
        const logs = db.dailyLogCounts(ctx.filter);

        const days = [...new Set([...users.keys(), ...logs.keys()])]
            .toSorted((a, b) => a - b);

        const pins = db.pinned();
        let pinned: ui.PinnedRow[] = [];
        const visible = peak(users.values()) >= k;
        const choice = versionChoice(c, ctx.filter);

        if (visible && pins.length > 0) {
            const rows = choice.pair
                ? db.bucketsForVersions(
                    ctx.filter,
                    choice.pair,
                    pins.map((p) => p.hash),
                )
                : [];

            const pinLogs = choice.pair
                ? db.logsForVersions(
                    ctx.filter,
                    choice.pair,
                    pins.map((p) => p.hash),
                )
                : new Map<bigint, [number, number]>();

            pinned = pins.map((p) => {
                const own = rows.filter((r) => r.hash === p.hash);
                const a = own.filter((r) => r.version === choice.pair?.[0]);
                const b = own.filter((r) => r.version === choice.pair?.[1]);

                return {
                    hex: hashToHex(p.hash),
                    name: p.name,
                    overall: summarize(db.buckets(p.hash, ctx.filter)),
                    comparison: a.length > 0 && b.length > 0
                        ? compareBuckets(a, b, ...(pinLogs.get(p.hash) ?? []))
                        : null,
                };
            });
        }

        return c.html(ui.overviewPage(ctx, {
            pinned,
            pinCount: pins.length,
            visible,
            minUsers: k,
            pair: choice.pair,
            today: users.get(dayOf(Date.now())) ?? 0,
            daily: days.map((day) => ({
                day,
                users: users.get(day) ?? 0,
                logs: logs.get(day) ?? 0,
            })),
        }));
    });

    app.get('/histograms', (c) => {
        const ctx = pageContext(c, deps, 'histograms');
        const q = (c.req.query('q') ?? '').trim();

        if (peakUsers(ctx.filter) < k) {
            return c.html(ui.tooFewPage(ctx, { q, minUsers: k }));
        }

        const hash = hashFromHex(q);

        const rows = db.listHistograms(
            ctx.filter,
            hash !== null ? { hash } : { text: q },
        );

        return c.html(ui.histogramsPage(ctx, {
            q,
            logs: db.logCount(ctx.filter),
            names: db.nameCount(),
            rows: rows.map((r) => ({
                hex: hashToHex(r.hash),
                name: r.name,
                logs: r.logs,
                samples: r.samples,
                mean: r.samples === 0 ? null : r.sum / r.samples,
            })),
        }));
    });

    app.get('/h/:hex', (c) => {
        const hash = hashFromHex(c.req.param('hex'));

        if (hash === null) {
            return c.html(
                ui.messagePage('Not found', 'Invalid histogram hash.'),
                404,
            );
        }

        const ctx = pageContext(c, deps, 'histograms');
        const users = db.dailyUsers(ctx.filter);

        if (peak(users.values()) < k) {
            return c.html(ui.tooFewPage(ctx, { q: '', minUsers: k }));
        }

        // Single days and versions get the same threshold as the whole view.
        const daily = db.daily(hash, ctx.filter)
            .filter((d) => (users.get(d.day) ?? 0) >= k);

        const totalLogs = db.dailyLogCounts(ctx.filter);
        const buckets = db.buckets(hash, ctx.filter);
        const sum = db.daily(hash, ctx.filter).reduce((n, d) => n + d.sum, 0);

        const versions = groupBy(
            db.bucketsByVersion(hash, ctx.filter),
            (b) => b.version,
        ).entries()
            .filter(([version]) => peakUsers({ ...ctx.filter, version }) >= k)
            .map(([version, rows]) => ({
                version,
                summary: summarize(rows),
                mean: approxMean(rows),
            }))
            .toArray()
            .toSorted((a, b) =>
                b.version.localeCompare(a.version, undefined, { numeric: true })
            );

        return c.html(ui.histogramPage(ctx, {
            pinned: db.isPinned(hash),
            hex: hashToHex(hash),
            name: db.nameFor(hash),
            logs: db.logCount(ctx.filter),
            histogramLogs: daily.reduce((n, d) => n + d.logs, 0),
            summary: summarize(buckets, sum),
            enumLike: isEnumLike(buckets),
            buckets,
            versions,
            daily: daily.map((d) => ({
                day: d.day,
                logs: d.logs,
                totalLogs: totalLogs.get(d.day) ?? 0,
                samples: d.samples,
                mean: d.samples === 0 ? null : d.sum / d.samples,
            })),
        }));
    });

    app.get('/changes', (c) => {
        const ctx = pageContext(c, deps, 'changes');
        delete ctx.filter.version;
        const choice = versionChoice(c, ctx.filter);

        if (!choice.pair) {
            return c.html(ui.changesPage(ctx, { choice, rows: [], mix: null }));
        }

        const pair = choice.pair;

        const rank = (filter: Filter, os: string | null) =>
            rankChanges(
                db.bucketsForVersions(filter, pair),
                db.logsForVersions(filter, pair),
                pair,
                os,
            );

        // Regressions are often platform-specific and get diluted across
        // all platforms, so without an OS filter each OS is ranked too, if
        // both versions have enough users on it.
        const perOs = ctx.filter.os ? [] : ctx.options.os
            .filter((os) =>
                pair.every((version) =>
                    peakUsers({ ...ctx.filter, os, version }) >= k
                )
            )
            .map((os) => rank({ ...ctx.filter, os }, os));

        const rows = mergeChanges([
            rank(ctx.filter, ctx.filter.os ?? null),
            ...perOs,
        ]).slice(0, 100);

        // Early in a rollout the new version's users aren't a random sample;
        // flag it when the platform mix differs a lot.
        const dimension = ctx.filter.os ? 'arch' : 'os';

        const [ma, mb] = choice.pair.map((version) =>
            db.mix({ ...ctx.filter, version }, dimension)
        );

        const values = [...new Set([...ma.keys(), ...mb.keys()])].toSorted();

        const mix = mixShift(ma, mb) > 0.1
            ? {
                dimension,
                rows: values.map((value) => ({
                    value,
                    a: shares(ma)(value),
                    b: shares(mb)(value),
                })),
            }
            : null;

        return c.html(ui.changesPage(ctx, {
            choice,
            mix,
            rows: rows.map((r) => ({
                ...r,
                hex: hashToHex(r.hash),
                name: db.nameFor(r.hash),
            })),
        }));
    });

    const pinRoute = (pin: boolean) => async (c: Context<Env>) => {
        const hash = hashFromHex(c.req.param('hex') ?? '');

        if (hash === null) {
            return c.html(
                ui.messagePage('Not found', 'Invalid histogram hash.'),
                404,
            );
        }

        if (pin) {
            db.pin(hash);
        } else {
            db.unpin(hash);
        }

        const back = new URL(c.req.url).search;

        return c.redirect(`/h/${hashToHex(hash)}${back}`, 303);
    };

    app.post('/h/:hex/pin', pinRoute(true));
    app.post('/h/:hex/unpin', pinRoute(false));

    return app;
}
