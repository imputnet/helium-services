import { decodeBase64, encodeBase64 } from './base64url.ts';
import { parseURLStrict } from './util.ts';

const _get_secret = () => {
    if (Deno.env.has('HMAC_SECRET')) {
        const secret = Deno.env.get('HMAC_SECRET')!;
        if (secret.length >= 32) {
            return new TextEncoder().encode(secret);
        }
    }

    return crypto.getRandomValues(new Uint8Array(32));
};

const _get_base_origin = () => {
    if (!Deno.env.has('PROXY_BASE_URL')) {
        console.error('PROXY_BASE_URL is not set, CRX requests will not be proxied');
    } else {
        return new URL(Deno.env.get('PROXY_BASE_URL')!);
    }
};

const baseOrigin = _get_base_origin();
const secret = await crypto.subtle.importKey(
    'raw',
    _get_secret(),
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign', 'verify'],
);

const sign = async (url: string) => {
    parseURLStrict(url); // sanity check, should throw if url is invalid

    const signature = await crypto.subtle.sign(
        'HMAC',
        secret,
        new TextEncoder().encode(url),
    );
    return encodeBase64(signature);
};

const verify = async (url: string, sig: string) => {
    parseURLStrict(url); // sanity check, should throw if url is invalid

    const signature = decodeBase64(sig);
    const ok = await crypto.subtle.verify(
        'HMAC',
        secret,
        signature,
        new TextEncoder().encode(url),
    );

    if (!ok) {
        throw 'signature verification failed';
    }
};

export const wrap = async (url: string) => {
    if (!baseOrigin) {
        return url;
    }

    const proxyURL = new URL(baseOrigin);
    proxyURL.pathname = '/proxy';
    proxyURL.searchParams.set('url', url);
    proxyURL.searchParams.set('sig', await sign(url));

    return proxyURL.toString();
};

export const unwrap = async (url_: string) => {
    const url = new URL(url_);
    const originalURL = url.searchParams.get('url');
    const signature = url.searchParams.get('sig');

    if (!originalURL || !signature) {
        throw 'malformed url';
    }

    await verify(originalURL, signature);
    return originalURL;
};
