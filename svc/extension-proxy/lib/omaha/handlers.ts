import * as Mixins from './mixins.ts';
import * as Helpers from './helpers.ts';
import * as OmahaRequest from './request.ts';
import * as ResponseHandler from './response.ts';

import * as Util from '../util.ts';

export const handleOmahaQuery = async (request: Request) => {
    const { apps, protocol, responseType } = await Helpers.getData(request);
    const serviceId = Helpers.getServiceId(request);
    const filteredApps = Helpers.checkAndFilterApps(serviceId, apps);

    if (filteredApps.length === 0) {
        throw 'no allowed extension IDs left to fetch';
    }

    const appsWithMixin = Util.shuffle(
        Mixins.addRandomExtensions(serviceId, filteredApps),
    );

    const omahaResponse = await OmahaRequest.request(
        { serviceId, protocolVersion: protocol },
        appsWithMixin,
        { userAgent: request.headers.get('user-agent') || '' },
    );

    Mixins.addToPoolFromResponse(serviceId, omahaResponse);
    return ResponseHandler.createResponse(
        responseType,
        protocol,
        Mixins.unmixResponse(filteredApps, omahaResponse),
    );
};
