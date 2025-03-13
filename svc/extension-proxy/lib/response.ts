import { OMAHA_JSON_PREFIX } from './omaha/constants.ts';
import { OmahaResponse } from './omaha/response.ts';
import { ResponseType } from './request.ts';
import { respond } from './util.ts';
import * as xml from 'jsr:@libs/xml';

const transformURL = (url: string) => {
    // TODO: crx proxying
    return url;
};

const filterResponse = ({ response }: OmahaResponse) => {
    return {
        server: response.server,
        protocol: response.protocol,
        daystart: response.daystart,
        app: response.app?.map((app) => {
            const updatecheck = app.updatecheck;

            if (updatecheck?.status === 'ok') {
                updatecheck.urls.url.map((obj) => {
                    if ('codebase' in obj) {
                        obj.codebase = transformURL(obj.codebase);
                    } else {
                        throw 'differential updates are not supported here';
                    }

                    return obj;
                });

                updatecheck.manifest.packages.package.map((obj) => {
                    obj.fp = '';
                    return obj;
                });
            }

            return {
                appid: app.appid,
                status: app.status,
                cohort: '',
                cohortname: '',
                cohorthint: '',
                ping: app.ping,
                updatecheck,
            };
        }),
    };
};

const handleRedirect = (data: OmahaResponse) => {
    const updateCheck = data?.response?.app?.[0]?.updatecheck;

    if (
        updateCheck?.status === 'ok' &&
        'codebase' in updateCheck?.urls?.url?.[0]
    ) {
        return respond(302, 'Found', {
            location: updateCheck.urls.url[0].codebase,
        });
    }

    return respond(404, 'Not Found');
};

const makeHeaders = ({ response }: OmahaResponse) => {
    return {
        'x-daynum': String(response.daystart.elapsed_days),
        'x-daystart': String(response.daystart.elapsed_seconds),
        'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
        'accept-ranges': 'none',
        pragma: 'no-cache',
    };
};

const handleJSON = (response: OmahaResponse) => {
    return respond(200, OMAHA_JSON_PREFIX + JSON.stringify(response), {
        ...makeHeaders(response),
        'content-type': 'application/json; charset=utf-8',
    });
};

const handleXML = ({ response }: OmahaResponse) => {
    return respond(
        200,
        xml.stringify({
            '@version': '1.0',
            '@encoding': 'UTF-8',
            gupdate: {
                '@xmlns': 'http://www.google.com/update2/response',
                '@protocol': '2.0',
                '@server': response.server,
                daystart: {
                    '@elapsed_days': response.daystart.elapsed_days,
                    '@elapsed_seconds': response.daystart.elapsed_seconds,
                },
                app: response.app?.map((app) => {
                    let updatecheck = null;

                    if (app.updatecheck?.status === 'ok') {
                        const urls = app.updatecheck.urls.url[0];
                        const package_ = app.updatecheck.manifest.packages.package[0];
                        if ('codebase' in urls) {
                            updatecheck = {
                                '@status': app.updatecheck?.status,
                                '@fp': '',
                                '@hash_sha256': package_.hash_sha256,
                                '@size': package_.size,
                                '@protected': '0',
                                '@version': app.updatecheck.manifest.version,
                                '@codebase': urls.codebase,
                            };
                        } else {
                            throw 'differential updates are not supported here';
                        }
                    } else {
                        updatecheck = app.updatecheck;
                    }

                    return {
                        '@appid': app.appid,
                        '@status': app.status,
                        ...(app.cohort ? { '@cohort': '', '@cohortname': '' } : {}),
                        ...(updatecheck ? { updatecheck } : {}),
                    };
                }),
            },
        }),
        {
            ...makeHeaders({ response }),
            'content-type': 'application/xml; charset=utf-8',
        },
    );
};

export function createResponse(
    responseType: ResponseType,
    data: OmahaResponse,
): Response {
    data.response = filterResponse(data);

    if (responseType === 'redirect') {
        return handleRedirect(data);
    } else if (responseType === 'json') {
        return handleJSON(data);
    } else if (responseType === 'xml') {
        return handleXML(data);
    } else {
        throw 'unreachable';
    }
}
