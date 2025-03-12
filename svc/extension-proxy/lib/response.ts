import { OmahaResponse } from './omaha/response.ts';
import { ResponseType } from './request.ts';

const transformURL = (url: string) => {
    // TODO: crx proxying
    return url;
};

const handleRedirect = (data: OmahaResponse) => {
    const updateCheck = data?.response?.app?.[0]?.updatecheck;

    if (
        updateCheck?.status === 'ok' &&
        'codebase' in updateCheck?.urls?.url?.[0]
    ) {
        return new Response(
            'Found',
            {
                status: 302,
                headers: {
                    location: transformURL(
                        updateCheck.urls.url[0].codebase,
                    ),
                },
            },
        );
    }

    return new Response('Not Found', { status: 404 });
};

const handleJSON = (_data: OmahaResponse) => {
    return new Response('soon', { status: 500 });
};

const handleXML = (_data: OmahaResponse) => {
    return new Response('soon', { status: 500 });
};

export function createResponse(
    responseType: ResponseType,
    data: OmahaResponse,
): Response {
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
