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
    fallback: number,
    max: number,
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
    maxTtlSeconds: getNumberClamped(
        'MINIPUSH_MAX_TTL_SECONDS',
        0,
        30,
        Infinity,
    ),
    maxQueuedPerChannel: getNumberClamped(
        'MINIPUSH_MAX_QUEUED_PER_CHANNEL',
        0,
        64,
        Infinity,
    ),
    maxChannelsPerUaid: getNumberClamped(
        'MINIPUSH_MAX_CHANNELS_PER_UAID',
        1,
        1024,
        Infinity,
    ),
    maxMailboxBytes: getNumberClamped(
        'MINIPUSH_MAX_MAILBOX_BYTES',
        0,
        256 * 1024 * 1024,
        Infinity,
    ),
    idleTimeoutSeconds: getNumberClamped(
        'MINIPUSH_IDLE_TIMEOUT_SECONDS',
        5,
        60,
        3600,
    ),
    ackTimeoutMs: getNumberClamped(
        'MINIPUSH_ACK_TIMEOUT_MS',
        100,
        60_000,
        Infinity,
    ),
    ackGraceMs: getNumberClamped('MINIPUSH_ACK_GRACE_MS', 0, 2000, Infinity),
    drainSeconds: getNumberClamped('MINIPUSH_DRAIN_SECONDS', 0, 30, Infinity),
    rateLimitWindowMs: getNumber('MINIPUSH_RATE_LIMIT_WINDOW', 60 * 1000),
    rateLimitPerChannel: getNumber('MINIPUSH_RATE_LIMIT_PER_CHANNEL', 300),
    rateLimitConnectsPerIp: getNumber(
        'MINIPUSH_RATE_LIMIT_CONNECTS_PER_IP',
        600,
    ),
    trustProxy: getBoolean('MINIPUSH_TRUST_PROXY', false),

    // TODO: this is not actually implemented.
    requireVapid: getBoolean('MINIPUSH_REQUIRE_VAPID', false),

    log: function () {
        console.log(
            Object.fromEntries(
                Object.entries(this)
                    .map(([k, v]) => [
                        k,
                        k.toLowerCase().includes('secret') ? '***' : v,
                    ])
                    .filter(([, v]) => typeof v !== 'function'),
            ),
        );
    },
});
