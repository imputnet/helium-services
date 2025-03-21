import { decodeBase64, encodeBase64 } from './base64url.ts';
import * as Util from './util.ts';

const _get_secret = () => {
    if (Deno.env.has('HMAC_SECRET')) {
        const secret = Deno.env.get('HMAC_SECRET')!;
        if (secret.length >= 32) {
            return new TextEncoder().encode(secret);
        }
    }

    console.error('HMAC_SECRET is not set or <32 chars, CRX requests will not be proxied');
};

const _get_base_origin = () => {
    if (!Deno.env.has('PROXY_BASE_URL')) {
        console.error('PROXY_BASE_URL is not set, CRX requests will not be proxied');
    } else {
        return new URL(Deno.env.get('PROXY_BASE_URL')!);
    }
};

const baseOrigin = _get_base_origin();
const secret_str = _get_secret();
const secret = secret_str && await crypto.subtle.importKey(
    'raw',
    secret_str,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign', 'verify'],
);

const sign = async (url: string, expiry: number) => {
    Util.parseURLStrict(url); // sanity check, should throw if url is invalid

    const signature = await crypto.subtle.sign(
        'HMAC',
        secret!,
        new TextEncoder().encode(
            JSON.stringify({ url, expiry }),
        ),
    );

    return encodeBase64(signature);
};

const verify = async (url: string, exp: string, sig: string) => {
    Util.parseURLStrict(url); // sanity check, should throw if url is invalid

    const signature = decodeBase64(sig);
    const ok = await crypto.subtle.verify(
        'HMAC',
        secret!,
        signature,
        new TextEncoder().encode(
            JSON.stringify({ url, expiry: Number(exp) }),
        ),
    );

    if (!ok) {
        throw 'signature verification failed';
    }
};

export const wrap = async (url: string) => {
    if (!baseOrigin || !secret) {
        return url;
    }

    const proxyURL = new URL(baseOrigin);
    const expiry = Util.now() + Util.ms.seconds(1);

    proxyURL.pathname = '/proxy';
    proxyURL.searchParams.set('url', url);
    proxyURL.searchParams.set('sig', await sign(url, expiry));
    proxyURL.searchParams.set('exp', expiry.toString());

    return proxyURL.toString();
};

export const unwrap = async (url_: string) => {
    if (!baseOrigin || !secret) {
        throw { status: 404, text: 'content proxying is disabled' };
    }

    const url = new URL(url_);
    const originalURL = url.searchParams.get('url');
    const signature = url.searchParams.get('sig');
    const expiry = url.searchParams.get('exp');

    if (!originalURL || !signature || !expiry) {
        throw 'malformed url';
    }

    await verify(originalURL, expiry, signature);

    if (Util.now() > +expiry) {
        throw { status: 410, text: 'URL expired' };
    }

    return originalURL;
};
