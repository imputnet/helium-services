import { bool, number, optional, required } from '@helium-services/common/env';

import * as Util from './util.ts';

const getNumberClamped = (
    name: string,
    min: number,
    fallback: number,
    max: number,
) => Util.clamp(number(name, fallback), min, max);

const hostname = optional('MINIPUSH_BIND_HOSTNAME') ?? '127.0.0.1';
const port = number('MINIPUSH_PORT', 10001);

export const env = Object.freeze({
    bindHostname: hostname,
    port,
    baseUrl: optional('MINIPUSH_BASE_URL') ?? `http://${hostname}:${port}/`,
    hmacSecret: required('MINIPUSH_HMAC_SECRET'),
    endpointSecret: required('MINIPUSH_ENDPOINT_SECRET'),
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
    maxMailboxBytes: getNumberClamped(
        'MINIPUSH_MAX_MAILBOX_BYTES',
        0,
        256 * 1024 * 1024,
        Infinity,
    ),
    rateLimitWindowMs: number('MINIPUSH_RATE_LIMIT_WINDOW', 60 * 1000),
    rateLimit: number('MINIPUSH_RATE_LIMIT', 1000),

    // TODO: this is not actually implemented.
    requireVapid: bool('MINIPUSH_REQUIRE_VAPID'),

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
