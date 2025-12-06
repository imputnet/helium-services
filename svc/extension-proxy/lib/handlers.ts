import * as Util from './util.ts';
import * as Omaha from './omaha/index.ts';
import * as Mixins from './omaha/mixins.ts';
import * as ExtensionProxy from './proxy.ts';
import * as RequestHelpers from './helpers.ts';
import * as ResponseHandler from './response.ts';
import * as OmahaConstants from './omaha/constants.ts';

const handleOmahaQuery = async (request: Request) => {
    const { apps, responseType } = await RequestHelpers.getData(request);
    const serviceId = RequestHelpers.getOmahaServiceId(request);
    const filteredApps = RequestHelpers.checkAndFilterApps(serviceId, apps);

    const appsWithMixin = Util.shuffle(
        Mixins.addRandomExtensions(serviceId, filteredApps),
    );

    const omahaResponse = await Omaha.request(
        serviceId,
        appsWithMixin,
        { userAgent: request.headers.get('user-agent') || '' },
    );

    Mixins.addToPoolFromResponse(serviceId, omahaResponse);
    return ResponseHandler.createResponse(
        responseType,
        Mixins.unmixResponse(filteredApps, omahaResponse),
    );
};

const handleProxy = async (url: string, headers?: Headers, method = 'GET') => {
    const response = await fetch(url, {
        method,
        headers,
    });

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: Util.filterHeaders(
            response.headers,
            Util.SAFE_RESPONSE_HEADERS,
        ),
    });
};

const handlePayloadProxy = async (request: Request) => {
    if (request.method !== 'GET') {
        throw { status: 405, text: 'method not allowed' };
    }

    const originalURL = await ExtensionProxy.unwrap(request.url);
    return handleProxy(
        originalURL,
        Util.filterHeaders(
            request.headers,
            Util.SAFE_REQUEST_HEADERS,
        ),
    );
};

const handleSnippetProxy = (request: Request) => {
    if (!['GET', 'POST'].includes(request.method)) {
        throw { status: 405, text: 'method not allowed' };
    }

    const extensionId = new URL(request.url).searchParams.get('id');

    if (!extensionId || !RequestHelpers.APP_ID_REGEX.test(extensionId)) {
        throw 'missing or invalid extension id';
    }

    // some google bullshit as usual
    const headers = new Headers();
    headers.set('Accept', 'application/x-protobuf');
    headers.set('Content-Type', 'application/x-protobuf');
    headers.set('X-HTTP-Method-Override', 'GET');

    return handleProxy(
        OmahaConstants.CHROME_WEBSTORE_SNIPPET
            .replace('{}', extensionId),
        headers,
        'POST',
    );
};

type RequestHandler = (request: Request) => Promise<Response>;
const handlers: Record<string, RequestHandler> = {
    '/proxy': handlePayloadProxy,
    '/cws_snippet': handleSnippetProxy,
    '/com': handleOmahaQuery,
    '/': handleOmahaQuery,
};

export const handle = (request: Request) => {
    const pathname = RequestHelpers.getCanonicalPathname(request);

    if (Object.hasOwn(handlers, pathname)) {
        return handlers[pathname](request);
    }

    throw { status: 404, text: 'Not Found' };
};
