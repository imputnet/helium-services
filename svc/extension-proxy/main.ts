import * as Util from './lib/util.ts';
import * as Mixins from './lib/mixins.ts';
import * as Omaha from './lib/omaha/index.ts';
import * as ExtensionProxy from './lib/proxy.ts';
import * as RequestHandler from './lib/request.ts';
import * as ResponseHandler from './lib/response.ts';

const handleOmahaQuery = async (request: Request) => {
    const { apps, responseType } = await RequestHandler.getData(request);
    RequestHandler.normalizeApps(apps);

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

const handlePayloadProxy = async (request: Request) => {
    const originalURL = await ExtensionProxy.unwrap(request.url);
    const response = await fetch(originalURL, {
        headers: Util.filterHeaders(
            request.headers,
            Util.SAFE_REQUEST_HEADERS,
        ),
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

const handle = (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/proxy')) {
        return handlePayloadProxy(request);
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
