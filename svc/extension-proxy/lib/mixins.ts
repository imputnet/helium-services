import { ServiceId } from './omaha/constants.ts';
import { App } from './omaha/request.ts';
import { OmahaResponse } from './omaha/response.ts';
import * as Util from './util.ts';

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

const addToPool = (id: ServiceId, { appid, version }: App) => {
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
    if (!response.app) {
        return;
    }

    response.app
        .map((app) => {
            if (
                app.updatecheck?.status === 'ok' &&
                app.updatecheck.manifest.version
            ) {
                return {
                    appid: app.appid,
                    version: app.updatecheck.manifest.version,
                };
            }
        })
        .filter((a) => a !== undefined)
        .map((app) => addToPool(id, app));
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
    if (response.response.app) {
        const allowedIds = new Set(expectedApps.map((a) => a.appid));
        response.response.app = response.response.app?.filter((app) => {
            return allowedIds.has(app?.appid);
        });
    }

    return response;
};
