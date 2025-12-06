import * as Util from './lib/util.ts';
import * as Mixins from './lib/mixins.ts';
import * as Omaha from './lib/omaha/index.ts';
import * as ExtensionProxy from './lib/proxy.ts';
import * as RequestHelpers from './lib/helpers.ts';
import * as ResponseHandler from './lib/response.ts';
import * as OmahaConstants from './lib/omaha/constants.ts';

const handleOmahaQuery = async (request: Request) => {
    const { apps, responseType } = await RequestHelpers.getData(request);
    RequestHelpers.normalizeApps(apps);

    const appsWithMixin = Util.shuffle(Mixins.addRandomExtensions(apps));

    const omahaResponse = await Omaha.request(
        'CHROME_WEBSTORE',
        appsWithMixin,
        { userAgent: request.headers.get('user-agent') || '' },
    );

    Mixins.addToPoolFromResponse(omahaResponse);
    return ResponseHandler.createResponse(
        responseType,
        Mixins.unmixResponse(apps, omahaResponse),
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

const handle = (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/proxy')) {
        return handlePayloadProxy(request);
    } else if (url.pathname.endsWith('/cws_snippet')) {
        return handleSnippetProxy(request);
    }

    return handleOmahaQuery(request);
};

export default {
    async fetch(request: Request) {
        try {
            return await handle(request);
        } catch (e) {
            return Util.respondWithError(e);
        }
    },
};
