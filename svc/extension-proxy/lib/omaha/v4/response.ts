import { OMAHA_JSON_PREFIX } from '../constants.ts';
import * as ExtensionProxy from '../../proxy.ts';
import { makeHeaders } from '../response.ts';
import { addToPool } from '../mixins.ts';
import { respond } from '../../util.ts';

import type { OmahaResponse, OmahaResponseApp } from './types.ts';
import type { ResponseType, ServiceId } from '../types.ts';

const getBestUrl = (updatecheck: OmahaResponseApp['updatecheck']) => {
    if (updatecheck?.status !== 'ok') {
        return;
    }

    const pipeline = updatecheck.pipelines[0];
    if (!pipeline) {
        return;
    }

    const download_op = pipeline.operations.find((op) => op.type === 'download');
    if (!download_op) {
        return;
    }

    let backupUrl;
    for (const urlStr of download_op.urls?.map((u) => u?.url) || []) {
        if (!urlStr) {
            continue;
        }

        const url = new URL(urlStr);
        if (url.protocol === 'https:') {
            return url;
        }

        backupUrl = url;
    }

    return backupUrl;
};

type Updatecheck = OmahaResponseApp['updatecheck'];
const filterUpdatecheck = async (updatecheck: Updatecheck): Promise<Updatecheck> => {
    if (updatecheck.status !== 'ok') {
        return { status: 'noupdate' };
    }

    if (updatecheck.pipelines.length > 1) {
        throw 'updatecheck(v4): too many pipelines';
    }

    const pipeline = updatecheck.pipelines[0];
    const dlOps = pipeline.operations.filter((op) => op.type === 'download');
    const crxOps = pipeline.operations.filter((op) => op.type === 'crx3');

    if (pipeline.operations.length > dlOps.length + crxOps.length) {
        throw 'updatecheck(v4): unsupported ops';
    }

    const ops: typeof pipeline.operations = [];

    for (const dlOp of dlOps) {
        const url = getBestUrl(updatecheck);
        if (!url) {
            continue;
        }
        const wrappedUrl = await ExtensionProxy.wrap(url.toString());

        ops.push({
            type: 'download',
            size: dlOp.size,
            out: {
                sha256: dlOp?.out?.sha256,
            },
            urls: [
                {
                    url: wrappedUrl,
                },
            ],
        });
    }

    for (const crxOp of crxOps) {
        ops.push({
            type: 'crx3',
            in: {
                sha256: crxOp.in?.sha256,
            },
        });
    }

    return {
        status: 'ok',
        nextversion: updatecheck.nextversion,
        pipelines: [{
            pipeline_id: pipeline.pipeline_id,
            operations: ops,
        }],
    };
};

const filterResponse = async ({ response }: OmahaResponse) => {
    if (response.protocol !== '4.0') {
        throw 'trying to pass a non-v4 response through a v4 filter';
    }

    return {
        server: response.server,
        protocol: response.protocol,
        daystart: response.daystart,
        apps: response.apps && await Promise.all(response.apps.map(async (app) => (
            {
                appid: app.appid,
                status: app.status,
                cohort: '',
                cohortname: '',
                ping: {
                    status: app.ping.status,
                },
                updatecheck: await filterUpdatecheck(app.updatecheck),
            }
        ))),
    };
};

export const addToPoolFromResponse = (id: ServiceId, { response }: OmahaResponse) => {
    if (!response.apps) {
        return;
    }

    response.apps
        .map((app) => {
            const uc = app?.updatecheck;
            if (uc?.status === 'ok' && uc.nextversion) {
                return {
                    appid: app.appid,
                    version: uc.nextversion,
                };
            }
        })
        .filter((a) => a !== undefined)
        .map((app) => addToPool(id, app));
};

const handleJSON = (response: OmahaResponse) => {
    return respond(200, OMAHA_JSON_PREFIX + JSON.stringify(response), {
        ...makeHeaders(response),
        'content-type': 'application/json; charset=utf-8',
    });
};

export async function createResponse(
    responseType: ResponseType,
    data: OmahaResponse,
): Promise<Response> {
    data.response = await filterResponse(data);

    if (responseType === 'json') {
        return handleJSON(data);
    }

    throw `unsupported response type for omaha v4: ${responseType}`;
}
