import type { App, OmahaRequest } from './omaha/request.ts';

export type ResponseType = 'json' | 'xml' | 'redirect';

type RequestData = {
    apps: App[];
    responseType: ResponseType;
};

// https://source.chromium.org/chromium/chromium/src/+/b57eb751f425c85b08939b5aff213ad9ca2843dd:extensions/browser/updater/manifest_fetch_data.cc;l=119
const getAppsFromQuery = (params: string[]): App[] => {
    return params.map((str) => {
        const params = new URLSearchParams(str);
        const appid = params.get('id');

        if (!params.has('uc') || !appid) {
            throw 'invalid x string';
        }

        return {
            appid,
            version: params.get('v') ?? '0.0.0.0',
        };
    });
};

const handleGet = (request: Request) => {
    const url = new URL(request.url);
    let responseType: RequestData['responseType'] = 'xml';

    if (url.searchParams.get('response') === 'redirect') {
        responseType = 'redirect';
    }

    const xParams = url.searchParams.getAll('x');
    if (
        xParams.length === 0 || (xParams.length > 1 && responseType === 'redirect')
    ) {
        throw 'malformed request';
    }

    return { responseType, apps: getAppsFromQuery(xParams) };
};

const handlePost = async (request: Request): Promise<RequestData> => {
    if (request.headers.get('content-type') !== 'application/json') {
        throw { status: 422, text: 'invalid content-type' };
    }

    let body: { request: OmahaRequest };
    try {
        body = await request.json();
    } catch {
        throw 'invalid body';
    }

    return {
        responseType: 'json',
        apps: body.request.app.map(
            ({ appid, version }) => ({ appid, version }),
        ),
    };
};

export const getData = async (request: Request): Promise<RequestData> => {
    if (request.method === 'GET') {
        return handleGet(request);
    } else if (request.method === 'POST') {
        return await handlePost(request);
    }

    throw { status: 405, text: 'method not allowed' };
};

const APP_ID_REGEX = /^[a-p]{32}$/;

export const normalizeApps = (apps: App[]) => {
    const ids = new Set();

    apps.forEach((obj) => {
        const { appid, version } = obj;

        if (ids.has(appid)) {
            throw `duplicates not allowed -- ${appid}`;
        } else if (!APP_ID_REGEX.test(appid)) {
            throw `invalid app id -- ${appid}`;
        } else if (version.length > 16 || version.length === 0) {
            throw `invalid version -- ${version}`;
        }

        ids.add(appid);
    });
};
