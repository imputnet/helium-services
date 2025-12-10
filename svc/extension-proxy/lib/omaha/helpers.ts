import * as V3 from './v3/index.ts';
import * as V4 from './v4/index.ts';
import type { App, OmahaRequest, ProtocolVersion, ResponseType, ServiceId } from './types.ts';

export * from '../helpers.ts';

type RequestData = {
    apps: App[];
    protocol: ProtocolVersion;
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

const handleGet = (request: Request): RequestData => {
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

    return {
        responseType,
        protocol: 3,
        apps: getAppsFromQuery(xParams),
    };
};

const getAppsForProtocol = (
    request: OmahaRequest,
    protocol: ProtocolVersion,
): App[] => {
    let appList: App[];

    if (protocol === 3) {
        appList = (request as V3.OmahaRequest).app;
    } else if (protocol === 4) {
        appList = (request as V4.OmahaRequest).apps;
    } else {
        throw 'unreachable';
    }

    if (!appList) {
        throw 'malformed request';
    }

    return appList.map((app) => ({
        appid: app.appid,
        version: app.version,
        brand: app.brand,
        updatecheck: app.updatecheck && {
            cause: 'cause' in app.updatecheck ? app.updatecheck.cause : undefined,
            sameversionupdate: 'sameversionupdate' in app.updatecheck
                ? app.updatecheck.sameversionupdate
                : undefined,
            rollback_allowed: app.updatecheck.rollback_allowed,
            targetversionprefix: app.updatecheck.targetversionprefix,
            updatedisabled: app.updatecheck.updatedisabled,
        },
    }));
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

    const protocolStr = body.request.protocol;
    let protocol: ProtocolVersion;
    if (protocolStr?.startsWith('3.')) {
        protocol = 3;
    } else if (protocolStr?.startsWith('4.')) {
        protocol = 4;
    } else {
        throw `unknown omaha protocol version: "${protocolStr}"`;
    }

    const apps = getAppsForProtocol(body.request, protocol);
    return {
        responseType: 'json',
        protocol,
        apps,
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

export const getServiceId = (request: Request): ServiceId => {
    const { pathname } = new URL(request.url);
    if (pathname === '/com') {
        return 'CHROME_COMPONENTS';
    }

    return 'CHROME_WEBSTORE';
};
