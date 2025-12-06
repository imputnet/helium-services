import {
    MAX_EXTENSIONS_PER_REQUEST,
    OMAHA_JSON_PREFIX,
    REQUEST_TEMPLATE,
    type ServiceId,
    UPDATE_SERVICES,
} from './constants.ts';
import type { OmahaResponse } from './response.ts';

import * as Util from '../util.ts';
import * as Chromium from '../data/chromium-version.ts';

export type App = {
    appid: string;
    version: string;
    brand?: string;
    updatecheck?: {
        rollback_allowed?: boolean;
        sameversionupdate?: boolean;
        targetversionprefix?: string;
        updatedisabled?: boolean;
    };
};

type AppInternal = App & {
    enabled: boolean;
    installedby: string;
    installsource: string;
    lang: string;
    packages: {
        package: { fp: string }[];
    };
    ping: { r: -1 };
    updatecheck: Exclude<App['updatecheck'], undefined>;
};

export type OmahaRequest = Omit<typeof REQUEST_TEMPLATE, 'app'> & {
    app: AppInternal[];
};

const omaha_uuid = () => `{${crypto.randomUUID()}}`;

const craftRequest = async (apps: App[]) => {
    const request: OmahaRequest = structuredClone(REQUEST_TEMPLATE);
    const browserVersion = await Chromium.getRandomVersion();

    request.prodversion =
        request.updaterversion =
        request.updater.version =
            browserVersion;

    request.app = apps.map((app) => {
        const normalized_app: AppInternal = {
            appid: app.appid,
            enabled: true,
            installedby: 'internal',
            installsource: 'ondemand',
            lang: '',
            packages: { package: [{ fp: `2.${app.version}` }] },
            ping: { r: -1 },
            updatecheck: app.updatecheck || {},
            version: app.version,
        };

        return normalized_app;
    });
    request.hw.physmemory = Util.any([4, 8, 16]);
    request.requestid = omaha_uuid();
    request.sessionid = omaha_uuid();

    return { request };
};

export async function request(
    serviceId: ServiceId,
    apps: App[],
    extraData: { userAgent: string },
) {
    if (apps.length > MAX_EXTENSIONS_PER_REQUEST) {
        throw 'too many apps in a single request';
    }

    apps = Util.shuffle(apps);

    const appIds = apps.map((app) => app.appid).join(',');
    const body = await craftRequest(apps);
    const { updater } = body.request;

    const response = await fetch(UPDATE_SERVICES[serviceId], {
        method: 'POST',
        headers: {
            'user-agent': extraData.userAgent,
            'content-type': 'application/json',
            'priority': 'u=4, i',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'no-cors',
            'sec-fetch-site': 'none',
            'x-goog-update-appid': appIds,
            'x-goog-update-interactivity': 'bg',
            'x-goog-update-updater': `${updater.name}-${updater.version}`,
        },
        cache: 'no-cache',
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw 'response is not ok';
    }

    const jsonWithPrefix = await response.text();
    if (!jsonWithPrefix.startsWith(OMAHA_JSON_PREFIX)) {
        throw 'invalid response';
    }

    return JSON.parse(
        jsonWithPrefix.replace(OMAHA_JSON_PREFIX, ''),
    ) as OmahaResponse;
}
