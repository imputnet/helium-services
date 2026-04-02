import * as Util from './util.ts';

const get = (name: string, fallback?: string): string => {
    if (!name.startsWith('MINIPUSH_')) {
        throw 'env name must start with MINIPUSH_';
    }

    const value = Deno.env.get(name);
    if (value) {
        return value;
    } else if (fallback) {
        return fallback;
    }

    throw `${name} is required, but missing in envs`;
};

const getNumber = (name: string, fallback?: number) => {
    const valueStr = get(name, fallback ? String(fallback) : undefined);
    if (valueStr === undefined) {
        throw `${name} is required, but missing in envs`;
    }

    const value = +valueStr;
    if (!Number.isFinite(value)) {
        throw `invalid numeric value for ${name}: ${value}`;
    }

    return value;
};

const getNumberClamped = (
    name: string,
    min: number,
    max: number,
    fallback?: number,
) => Util.clamp(getNumber(name, fallback), min, max);

const getBoolean = (name: string, byDefault = false) => {
    const value = get(name, String(byDefault));
    return ['y', '1', 'true', 't', 'yes'].includes(value.toLowerCase());
};

const getHostname = () => get('MINIPUSH_BIND_HOSTNAME', '127.0.0.1');
const getPort = () => getNumber('MINIPUSH_PORT', 10001);

export const env = Object.freeze({
    bindHostname: getHostname(),
    port: getPort(),
    baseUrl: get('MINIPUSH_BASE_URL', `http://${getHostname()}:${getPort()}/`),
    hmacSecret: get('MINIPUSH_HMAC_SECRET'),
    endpointSecret: get('MINIPUSH_ENDPOINT_SECRET'),
    maxTtlSeconds: getNumberClamped('MINIPUSH_MAX_TTL_SECONDS', 0, 30, 30),
    maxQueuedPerChannel: getNumberClamped(
        'MINIPUSH_MAX_QUEUED_PER_CHANNEL',
        0,
        64,
        64,
    ),
    rateLimitWindowMs: getNumber('MINIPUSH_RATE_LIMIT_WINDOW', 60 * 1000),
    rateLimit: getNumber('MINIPUSH_RATE_LIMIT', 1000),

    // TODO: this is not actually implemented.
    requireVapid: getBoolean('MINIPUSH_REQUIRE_VAPID', false),
});
