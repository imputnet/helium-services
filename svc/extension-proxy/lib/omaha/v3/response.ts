import * as ExtensionProxy from '../../proxy.ts';
import * as Util from '../../util.ts';
import * as xml from '@libs/xml';

import { OMAHA_JSON_PREFIX } from '../constants.ts';
import { makeHeaders } from '../response.ts';
import { addToPool } from '../mixins.ts';

import type { OmahaResponse, OmahaResponseApp } from './types.ts';
import type { ResponseType, ServiceId } from '../types.ts';

const getBestUrl = (updatecheck: OmahaResponseApp['updatecheck']) => {
    if (updatecheck?.status !== 'ok') {
        return;
    }

    let backupUrl;
    for (const urlObj of updatecheck.urls.url) {
        if (!('codebase' in urlObj)) {
            continue;
        }

        const url = new URL(urlObj.codebase);
        if (url.protocol === 'https:') {
            return url;
        }

        backupUrl = url;
    }

    return backupUrl;
};

const filterResponse = async ({ response }: OmahaResponse) => {
    if (response.protocol !== '3.0' && response.protocol !== '3.1') {
        throw 'trying to pass a non-v3 response through v3 filter';
    }

    return {
        server: response.server,
        protocol: response.protocol,
        daystart: response.daystart,
        app: response.app && await Promise.all(response.app.map(async (app) => {
            const updatecheck = app.updatecheck;

            if (updatecheck?.status === 'ok') {
                const url = getBestUrl(updatecheck);
                const fileName = updatecheck?.manifest?.packages?.package?.[0]?.name;
                if (!url) {
                    throw 'could not get any viable URL for download';
                }

                if (fileName) {
                    if (!url.pathname.endsWith('/')) {
                        url.pathname += '/';
                    }

                    url.pathname += fileName;
                }

                updatecheck.urls.url = [
                    { codebase: await ExtensionProxy.wrap(url.toString()) },
                ];
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
        })),
    };
};

const handleRedirect = (data: OmahaResponse) => {
    const updateCheck = data?.response?.app?.[0]?.updatecheck;

    if (
        updateCheck?.status === 'ok' &&
        'codebase' in updateCheck?.urls?.url?.[0]
    ) {
        return Util.respond(302, 'Found', {
            location: updateCheck.urls.url[0].codebase,
        });
    }

    return Util.respond(404, 'Not Found');
};

const handleJSON = (response: OmahaResponse) => {
    return Util.respond(200, OMAHA_JSON_PREFIX + JSON.stringify(response), {
        ...makeHeaders(response),
        'content-type': 'application/json; charset=utf-8',
    });
};

const handleXML = ({ response }: OmahaResponse) => {
    return Util.respond(
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
                    } else if (app.updatecheck) {
                        updatecheck = Object.fromEntries(
                            Object.entries(app.updatecheck)
                                .map(([key, value]) => [`@${key}`, value]),
                        );
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

export async function createResponse(
    responseType: ResponseType,
    data: OmahaResponse,
): Promise<Response> {
    data.response = await filterResponse(data);

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

export const addToPoolFromResponse = (id: ServiceId, { response }: OmahaResponse) => {
    if (!response.app) {
        return;
    }

    response.app
        .map((app) => {
            if (
                app.updatecheck?.status === 'ok' &&
                app.updatecheck.manifest.version
            ) {
                return {
                    appid: app.appid,
                    version: app.updatecheck.manifest.version,
                };
            }
        })
        .filter((a) => a !== undefined)
        .map((app) => addToPool(id, app));
};
