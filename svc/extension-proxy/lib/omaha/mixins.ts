import type { App, OmahaResponse, ServiceId } from './types.ts';

import * as Util from '../util.ts';
import * as V3 from './v3/index.ts';
import * as V4 from './v4/index.ts';

type Pool = Map<string, App>;

const pools: Partial<Record<ServiceId, Pool>> = {};

const MAX_EXTENSIONS_IN_POOL = 2 ** 11;

setInterval(() => {
    if (Object.keys(pools).length > 0) {
        console.log(`[mixins] Apps in mixin pool`);
        for (const [name, pool] of Object.entries(pools)) {
            console.log(`\t${name}: ${pool.size}`);
        }
    }
}, Util.ms.minutes(15));

const getPool = (id: ServiceId): Pool => {
    let pool = pools[id];

    if (!pool) {
        pool = new Map();
        pools[id] = pool;
    }

    return pool;
};

export const addToPool = (id: ServiceId, { appid, version }: App) => {
    const pool = getPool(id);
    const existing = pool.get(appid);
    if (existing) {
        const current = existing.version.split('.').map(Number);
        const incoming = version.split('.').map(Number);
        for (let i = 0; i < Math.max(current.length, incoming.length); ++i) {
            const difference = (incoming[i] ?? 0) - (current[i] ?? 0);
            if (difference > 0) {
                pool.set(appid, { appid, version });
            }
            if (difference !== 0) {
                break;
            }
        }
        return;
    }

    if (pool.size >= MAX_EXTENSIONS_IN_POOL) {
        pool.delete(Util.any([...pool.keys()]));
    }
    pool.set(appid, { appid, version });
};

export const addToPoolFromResponse = (
    id: ServiceId,
    { response }: OmahaResponse,
) => {
    if (response.protocol === '4.0') {
        return V4.addToPoolFromResponse(id, { response });
    } else if (response.protocol === '3.1') {
        return V3.addToPoolFromResponse(id, { response });
    }

    console.warn(
        '[warn] unknown protocol in addToPoolFromResponse',
        response.protocol,
    );
};

export const addRandomExtensions = (id: ServiceId, apps: readonly App[]) => {
    const nAppsToMixin = Math.ceil(2 * (1 + Math.log2(apps.length)));
    const idSet = new Set(apps.map((a) => a.appid));
    const pool = getPool(id);

    const candidates = [...pool.values()].filter(
        (app) => !idSet.has(app.appid),
    );
    const count = Math.min(nAppsToMixin, candidates.length);
    for (let i = 0; i < count && i < candidates.length - 1; ++i) {
        const j = i + Util.randomInt(candidates.length - i);
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const mixins = candidates.slice(0, count);

    return [...apps, ...mixins];
};

export const unmixResponse = (
    expectedApps: readonly App[],
    response: OmahaResponse,
) => {
    const allowedIds = new Set(expectedApps.map((a) => a.appid));
    const inner = response.response;

    if (inner.protocol === '4.0') {
        if (inner.apps) {
            inner.apps = inner.apps.filter((app) => {
                return allowedIds.has(app?.appid);
            });
        }
    } else if (inner.protocol === '3.1') {
        if (inner.app) {
            inner.app = inner.app.filter((app) => {
                return allowedIds.has(app.appid);
            });
        }
    } else {
        throw `unknown protocol to unmix: ${inner.protocol}`;
    }

    return response;
};
