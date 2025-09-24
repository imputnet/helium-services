/// <reference types="@types/node" />
import * as Stats from './stats.ts';
import z from 'node:zlib';

type PositiveCacheEntry = {
    expiry?: number;
    compressedData: ArrayBuffer;
    type: string;
    tag: string;
};

type NegativeCacheEntry = {
    expiry?: number;
    missing: true;
};

type CacheEntry =
    | PositiveCacheEntry
    | NegativeCacheEntry;

type Cache = Record<string, CacheEntry>;
type Producent = () => Promise<string>;
type Options = Partial<{
    type: string;
    expiry_seconds: number;
}>;

const _cache: Cache = {};
const _prpr: Record<string, ReturnType<Producent>> = {};
const _sepr: Record<string, Promise<void>> = {};

setInterval(() => {
    for (const [key, { expiry }] of Object.entries(_cache)) {
        if (expiry && expiry < Date.now()) {
            delete _cache[key];
        }
    }
}, 1000 * 60);

function compress(s: string) {
    const { promise, resolve, reject } = Promise.withResolvers<ArrayBuffer>();

    z.brotliCompress(s, {
        params: {
            [z.constants.BROTLI_PARAM_MODE]: z.constants.BROTLI_MODE_TEXT,
            [z.constants.BROTLI_PARAM_QUALITY]: 11,
            [z.constants.BROTLI_PARAM_SIZE_HINT]: s.length,
        },
    }, (err, data) => {
        if (err) {
            return reject(err);
        }

        resolve(new Uint8Array(data).buffer);
    });

    return promise;
}

async function tag(s: string) {
    const buf = await crypto.subtle.digest(
        { name: 'SHA-256' },
        new TextEncoder().encode(s),
    );

    // first 12 bytes should be plenty to ensure no collisions happen
    return ['"', ...new Uint32Array(buf).slice(0, 3), '"']
        .map((a) => a.toString(36)).join('');
}

async function set(key: string, value: string, options: Options) {
    const data: CacheEntry = {
        type: options.type ?? 'text/plain; charset=utf-8',
        tag: await tag(value),
        compressedData: await compress(value),
    };

    if (typeof options.expiry_seconds !== 'undefined') {
        data.expiry = Date.now() + options.expiry_seconds * 1000;
    }

    _cache[key] = data;
}

function has(key: string) {
    return key in _cache
        && (
            typeof _cache[key].expiry === 'undefined'
            || _cache[key].expiry > Date.now()
        );
}

async function _materialize(key: string, options: Options, source: Producent | null) {
    if (has(key)) {
        if (source !== null) {
            Stats.hit();
        }

        const value = _cache[key];
        if ('missing' in value) {
            throw { status: 404, text: 'Not Found' };
        }

        const { type, tag, compressedData } = value;
        return [new Blob([compressedData], { type }), tag] as const;
    } else if (source === null) {
        throw 'something went very wrong';
    }

    Stats.miss();

    let data;
    try {
        data = await (_prpr[key] ??= source());
    } catch (e) {
        _cache[key] = {
            missing: true,
            expiry: Date.now() + 30000,
        };
        throw e;
    } finally {
        delete _prpr[key];
    }

    try {
        await (_sepr[key] ??= set(key, data, options));
    } finally {
        delete _sepr[key];
    }
    return _materialize(key, options, null);
}

export const stats = () => {
    let count = 0, negative = 0, size = 0;
    for (const item of Object.values(_cache)) {
        ++count;
        if ('missing' in item) {
            ++negative;
        } else {
            size += item.compressedData.byteLength;
        }
    }

    return { count, negative, size };
};

export function materialize(key: string, options: Options, source: Producent) {
    return _materialize(key, options, source);
}
