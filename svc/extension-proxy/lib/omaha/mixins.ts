import type { App, OmahaResponse, ServiceId } from './types.ts';

import * as Util from '../util.ts';
import * as V3 from './v3/index.ts';
import * as V4 from './v4/index.ts';

type Pool = {
    data: App[];
    dedup: Set<string>;
};

const pools: Partial<Record<ServiceId, Pool>> = {};

const MAX_EXTENSIONS_IN_POOL = 2 ** 10;

setInterval(() => {
    for (const { data } of Object.values(pools)) {
        Util.shuffle(data);
    }
}, Util.ms.minutes(1));

setInterval(() => {
    if (Object.keys(pools).length > 0) {
        console.log(`[mixins] Apps in mixin pool`);
        for (const [name, { dedup }] of Object.entries(pools)) {
            console.log(`\t${name}: ${dedup.size}`);
        }
    }
}, Util.ms.minutes(15));

const getKey = (app: App) => `${app.appid}_${app.version}`;

const getPool = (id: ServiceId): Pool => {
    let pool = pools[id];

    if (!pool) {
        pool = { data: [], dedup: new Set() };
        pools[id] = pool;
    }

    return pool;
};

export const addToPool = (id: ServiceId, { appid, version }: App) => {
    const key = getKey({ appid, version });
    const { data: pool, dedup } = getPool(id);

    if (!dedup.has(key)) {
        dedup.add(key);
        pool.push({ appid, version });
    }

    if (pool.length >= MAX_EXTENSIONS_IN_POOL) {
        dedup.delete(
            getKey(pool.pop()!),
        );
    }
};

export const addToPoolFromResponse = (id: ServiceId, { response }: OmahaResponse) => {
    if (response.protocol === '4.0') {
        return V4.addToPoolFromResponse(id, { response });
    } else if (response.protocol === '3.1') {
        return V3.addToPoolFromResponse(id, { response });
    }

    console.warn('[warn] unknown protocol in addToPoolFromResponse', response.protocol);
};

export const addRandomExtensions = (id: ServiceId, apps: readonly App[]) => {
    const nAppsToMixin = Math.ceil(2 * (1 + Math.log2(apps.length)));
    const idSet = new Set(apps.map((a) => a.appid));
    const { data: pool } = getPool(id);

    const mixins = Util.shuffle(
        pool.filter((app) => !idSet.has(app.appid)),
    ).slice(0, nAppsToMixin);

    return [...apps, ...mixins];
};

export const unmixResponse = (expectedApps: readonly App[], response: OmahaResponse) => {
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
