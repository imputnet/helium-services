export const ms = {
    seconds: function (n: number) {
        return n * 1000;
    },
    minutes: function (n: number) {
        return this.seconds(n * 60);
    },
    hours: function (n: number) {
        return this.minutes(n * 60);
    },
};

export const now = () => new Date().getTime();

export const insecure_rand = (max: number, min: number = 0) => {
    max |= 0;
    min |= 0;

    return Math.floor(Math.random() * (max - min) + min);
};

export const any = <T>(arr: T[]) => arr[insecure_rand(arr.length)];

export const shuffle = <T>(arr: T[]) => {
    for (let i = arr.length - 1; i >= 0; --i) {
        const j = insecure_rand(i);
        if (i != j) {
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    }
    return arr;
};

export const respond = (
    status: number,
    response?: string | object,
    headers?: Record<string, string>,
) => {
    if (response && typeof response === 'object') {
        response = JSON.stringify(response);
    }
    response ||= '';

    headers ??= {};
    headers['content-type'] ??= 'text/plain';

    return new Response(response, { status, headers });
};

export const respondWithError = (e: unknown) => {
    if (typeof e === 'string') {
        e = { status: 400, text: e };
    }

    if (e instanceof Object) {
        if ('status' in e && 'text' in e) {
            return respond(e.status as number, `error ${e.status}: ${e.text}`);
        }
    }

    return respond(500, 'server error');
};

export const parseURLStrict = (url_: unknown) => {
    if (url_ instanceof URL) {
        return;
    }

    if (typeof url_ !== 'string') {
        throw 'url is not a string or URL object';
    }

    const url = new URL(url_);
    if (url.username || url.password || url.port) {
        throw 'usernames/passwords/ports in url are disallowed';
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw 'only http/https urls are supported';
    }

    return url;
};

export const SAFE_REQUEST_HEADERS = [
    'user-agent',
    'accept-encoding',
    'range',
    'if-match',
    'if-none-match',
    'if-modified-since',
    'if-range',
];

export const SAFE_RESPONSE_HEADERS = [
    'content-type',
    'etag',
    'last-modified',
    'accept-ranges',
    'content-length',
    'vary',
    'content-range',
];

export const filterHeaders = (old: Headers, allowlist: string[]) => {
    const headers = new Headers();

    for (const name of allowlist) {
        if (old.has(name)) {
            headers.set(name, old.get(name)!);
        }
    }

    return headers;
};
