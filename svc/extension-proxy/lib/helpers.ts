import type { App, ServiceId } from './omaha/index.ts';

export const APP_ID_REGEX = /^[a-p]{32}$/;

const APPID_ALLOWLIST: Partial<Record<ServiceId, Set<string>>> = {
    'CHROME_COMPONENTS': new Set([
        'hfnkpimlhhgieaddgfemjhofmfblmnib', // CRLSet
    ]),
};

export const checkAndFilterApps = (serviceId: ServiceId, apps: App[]) => {
    const ids = new Set();
    const allowlist = APPID_ALLOWLIST[serviceId];

    return apps.filter((obj) => {
        const { appid, version } = obj;

        if (ids.has(appid)) {
            throw `duplicates not allowed -- ${appid}`;
        } else if (!APP_ID_REGEX.test(appid)) {
            throw `invalid app id -- ${appid}`;
        } else if (version.length > 16 || version.length === 0) {
            throw `invalid version -- ${version}`;
        }

        if (!allowlist || allowlist.has(appid)) {
            ids.add(appid);
            return true;
        }
    });
};
