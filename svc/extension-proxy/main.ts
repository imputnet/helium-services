import * as Util from './lib/util.ts';
import * as Mixins from './lib/mixins.ts';
import * as Omaha from './lib/omaha/index.ts';
import * as RequestHandler from './lib/request.ts';
import * as ResponseHandler from './lib/response.ts';

const handle = async (request: Request) => {
    const { apps, responseType } = await RequestHandler.getData(request);

    const appsWithMixin = Util.shuffle(Mixins.addRandomExtensions(apps));

    const omahaResponse = await Omaha.request(
        'CHROME_WEBSTORE',
        appsWithMixin,
        { userAgent: request.headers.get('user-agent') || '' },
    );

    Mixins.addToPoolFromResponse(omahaResponse);
    return ResponseHandler.createResponse(
        responseType,
        Mixins.unmixResponse(apps, omahaResponse)
    );
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
