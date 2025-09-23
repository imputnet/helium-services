import * as Assets from './lib/ublock.ts';
import * as Util from './lib/util.ts';

const handleData = (request: Request) => {
    const url = new URL(request.url);

    if (url.pathname === '/assets.json') {
        return Assets.handleAssets();
    }

    return Assets.handleFilterlist(url.pathname);
};

const handle = async (request: Request): Promise<Response> => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        throw { status: 405, text: 'method not allowed' };
    }

    const acceptsBrotli = request.headers.get('accept-encoding')
        ?.split(', ', 8).some((enc) => enc === '*' || enc === 'br');

    if (!acceptsBrotli) {
        throw { status: 406, text: 'this service operates only with brotli-encoded responses' };
    }

    const [data, etag] = await handleData(request);
    const cachedOnClient = request.headers.get('if-none-match')
        ?.split(', ', 8)
        .includes(etag);

    const headers = {
        'Cache-Control': 'public, max-age=3600',
        'Content-Type': data.type,
        'Content-Length': String(data.size),
        'Content-Encoding': 'br',
        'ETag': etag,
    };

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                Allow: 'OPTIONS, GET, HEAD',
                ...headers,
            },
        });
    } else if (request.method === 'HEAD' || cachedOnClient) {
        return new Response(null, {
            status: cachedOnClient ? 304 : 200,
            headers,
        });
    }

    return new Response(
        data.stream(),
        { headers },
    );
};

if (import.meta.main) {
    // try to preload assets.json before any request arrives
    Assets.handleAssets().catch(() => {});
}

export default {
    async fetch(request: Request) {
        try {
            return await handle(request);
        } catch (e) {
            return Util.respondWithError(e);
        }
    },
};
