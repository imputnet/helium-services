import * as Stats from './stats.ts';
import * as Resource from './resource.ts';

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

async function set(key: string, value: string, options: Options) {
    const data: CacheEntry = {
        type: options.type ?? 'text/plain; charset=utf-8',
        tag: await Resource.tag(value),
        compressedData: await Resource.compress(value),
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

async function _materialize(
    key: string,
    options: Options,
    source: Producent | null,
) {
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

export function materialize(
    key: string,
    options: Options,
    source: Producent,
) {
    return _materialize(key, options, source);
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
