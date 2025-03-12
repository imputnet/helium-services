import * as Util from './lib/util.ts';
import * as Mixins from './lib/mixins.ts';
import * as Omaha from './lib/omaha/index.ts';
import * as RequestHandler from './lib/request.ts';
import * as ResponseHandler from './lib/response.ts';

const handle = async (request: Request) => {
    const { apps, responseType } = await RequestHandler.getData(request);

    const appsWithMixin = Util.shuffle(Mixins.addRandomExtensions(apps));

    // TODO: remove mixins from omaha response
    const omahaResponse = await Omaha.request(
        'CHROME_WEBSTORE',
        appsWithMixin,
        { userAgent: request.headers.get('user-agent') || '' },
    );

    Mixins.addFromResponse(omahaResponse);
    return ResponseHandler.createResponse(responseType, omahaResponse);
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
