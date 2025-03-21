import { App } from './omaha/request.ts';
import { OmahaResponse } from './omaha/response.ts';
import * as Util from './util.ts';

const extensionPool: App[] = [];
const extensionPoolDedup = new Set<string>();
const MAX_EXTENSIONS_IN_POOL = 2 ** 10;

const getKey = (app: App) => `${app.appid}_${app.version}`;

Deno.unrefTimer(
    setInterval(() => {
        Util.shuffle(extensionPool);
    }, Util.ms.minutes(1)),
);

Deno.unrefTimer(
    setInterval(() => {
        console.log(`[mixins] Apps in mixin pool: ${extensionPoolDedup.size}`);
    }, Util.ms.minutes(15)),
);

const addToPool = ({ appid, version }: App) => {
    const key = getKey({ appid, version });

    if (!extensionPoolDedup.has(key)) {
        extensionPoolDedup.add(key);
        extensionPool.push({ appid, version });
    }

    if (extensionPool.length >= MAX_EXTENSIONS_IN_POOL) {
        extensionPoolDedup.delete(
            getKey(extensionPool.pop()!),
        );
    }
};

export const addToPoolFromResponse = ({ response }: OmahaResponse) => {
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
        .map(addToPool);
};

export const addRandomExtensions = (apps: App[]) => {
    const nAppsToMixin = Math.ceil(2 * (1 + Math.log2(apps.length)));
    const idSet = new Set(apps.map((a) => a.appid));

    const mixins = Util.shuffle(
        extensionPool.filter((app) => !idSet.has(app.appid)),
    ).slice(0, nAppsToMixin);

    apps.push(...mixins);
    return apps;
};

export const unmixResponse = (expectedApps: App[], response: OmahaResponse) => {
    if (response.response.app) {
        const allowedIds = new Set(expectedApps.map((a) => a.appid));
        response.response.app = response.response.app?.filter((app) => {
            return allowedIds.has(app?.appid);
        });
    }

    return response;
};
