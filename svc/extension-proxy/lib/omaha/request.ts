import { MAX_EXTENSIONS_PER_REQUEST, OMAHA_JSON_PREFIX, UPDATE_SERVICES } from './constants.ts';

import * as Util from '../util.ts';
import * as V3 from './v3/index.ts';
import * as V4 from './v4/index.ts';
import * as Chromium from '../data/chromium-version.ts';

import type { App } from './index.ts';
import type { OmahaResponse, ProtocolVersion, ServiceId } from './types.ts';

const omaha_uuid = () => `{${crypto.randomUUID()}}`;

const requestTemplateFor = (version: ProtocolVersion) => {
    switch (version) {
        case 3:
            return Util.clone(V3.REQUEST_TEMPLATE) as V3.OmahaRequest;
        case 4:
            return Util.clone(V4.REQUEST_TEMPLATE) as V4.OmahaRequest;
        default:
            throw 'unknown protocol version ' + version;
    }
};

const craftRequest = async (apps: App[], version: ProtocolVersion) => {
    const request = requestTemplateFor(version);
    const browserVersion = await Chromium.getRandomVersion();

    request.prodversion = browserVersion;
    request.updaterversion = browserVersion;

    if ('updater' in request) {
        request.updater.version = browserVersion;
    }

    const normalizedApps = apps.map((app) => {
        const normalizedAppBase: App = {
            appid: app.appid,
            version: app.version,
        };

        if (version === 3) {
            const normalizedApp: V3.AppInternal = {
                ...normalizedAppBase,
                enabled: true,
                installedby: 'internal',
                installsource: 'ondemand',
                lang: '',
                packages: { package: [{ fp: `2.${app.version}` }] },
                ping: { r: -1 },
                updatecheck: app.updatecheck || {},
            };

            return normalizedApp;
        } else if (version === 4) {
            const normalizedApp: V4.AppInternal = {
                ...normalizedAppBase,
                enabled: true,
                installsource: 'ondemand',
                lang: '',
                ping: { r: -2 },
                updatecheck: app.updatecheck || {},
            };

            return normalizedApp;
        }

        throw 'unreachable';
    });

    if ('app' in request) {
        request.app = normalizedApps as V3.AppInternal[];
    } else if ('apps' in request) {
        request.apps = normalizedApps as V4.AppInternal[];
    }

    request.hw.physmemory = Util.any([4, 8, 16]);
    request.requestid = omaha_uuid();
    request.sessionid = omaha_uuid();

    return { request };
};

export async function request(
    { serviceId, protocolVersion }: {
        serviceId: ServiceId;
        protocolVersion: ProtocolVersion;
    },
    apps: App[],
    extraData: { userAgent: string },
) {
    if (apps.length > MAX_EXTENSIONS_PER_REQUEST) {
        throw 'too many apps in a single request';
    }

    apps = Util.shuffle(apps);

    const appIds = apps.map((app) => app.appid).join(',');
    const browserVersion = await Chromium.getRandomVersion();
    const body = await craftRequest(
        apps,
        protocolVersion,
    );

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
            'x-goog-update-interactivity': serviceId === 'CHROME_COMPONENTS' ? 'fg' : 'bg',
            'x-goog-update-updater': `chrome-${browserVersion}`,
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
