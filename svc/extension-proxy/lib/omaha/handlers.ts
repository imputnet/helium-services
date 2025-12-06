import * as Util from '../util.ts';
import * as Omaha from './index.ts';
import * as Mixins from './mixins.ts';
import * as RequestHelpers from '../helpers.ts';
import * as ResponseHandler from '../response.ts';

export const handleOmahaQuery = async (request: Request) => {
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
