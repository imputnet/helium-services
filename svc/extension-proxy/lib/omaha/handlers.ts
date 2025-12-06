import * as Mixins from './mixins.ts';
import * as Helpers from './helpers.ts';
import * as OmahaRequest from './request.ts';
import * as ResponseHandler from './response.ts';

import * as Util from '../util.ts';

export const handleOmahaQuery = async (request: Request) => {
    const { apps, responseType } = await Helpers.getData(request);
    const serviceId = Helpers.getServiceId(request);
    const filteredApps = Helpers.checkAndFilterApps(serviceId, apps);

    const appsWithMixin = Util.shuffle(
        Mixins.addRandomExtensions(serviceId, filteredApps),
    );

    const omahaResponse = await OmahaRequest.request(
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
