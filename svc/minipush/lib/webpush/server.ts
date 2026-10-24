import assert from 'node:assert/strict';
import { unwrap } from './chid.ts';
import { env } from '../env.ts';
import * as Buf from '../util/buffer.ts';
import type { StoredMessage } from '../home/mailbox.ts';
import * as HTTP from '../util/http.ts';
import * as MessageId from './message-id.ts';
import * as Router from '../mesh/router.ts';

const getTtl = (req: Request) => {
    const max = env.maxTtlSeconds;

    const ttlStr = req.headers.get('ttl') || '';
    if (!ttlStr) {
        return max;
    }

    const ttl = parseInt(ttlStr, 10);
    if (
        String(ttl) !== ttlStr
        || !Number.isSafeInteger(ttl)
        || ttl < 0
        || ttl > max
    ) {
        return max;
    }

    return ttl;
};

const stripQuotes = (headerValue: string | null) => {
    return headerValue?.replaceAll('"', '');
};

const getMessageLocation = (id: string) => {
    const url = new URL(env.baseUrl);
    if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
    }

    url.pathname += 'm/';
    url.pathname += id;
    return url.toString();
};

export const handleWebPushRequest = async (
    request: Request,
    params: URLPatternResult,
) => {
    const maybeError = HTTP.checkMethod(request, 'POST');
    if (maybeError) {
        return maybeError;
    }

    const { version, token } = params.pathname.groups;
    assert(version && token, 'version or token missing from url');

    let unwrapped;
    try {
        unwrapped = await unwrap(version, token);
    } catch {
        return new Response(null, { status: HTTP.status.BAD_REQUEST });
    }

    const { uaid, chid } = unwrapped;
    assert(uaid && chid, 'could not unwrap uaid/chid');

    const maxPayloadBytes = 4096;
    const bodyTimeoutMs = 10_000;
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxPayloadBytes) {
        return new Response(null, { status: HTTP.status.PAYLOAD_TOO_LARGE });
    }

    const body = await HTTP.readBoundedBodyWithTimeout(
        request,
        maxPayloadBytes,
        bodyTimeoutMs,
    );
    if (body === null) {
        return new Response(null, { status: HTTP.status.PAYLOAD_TOO_LARGE });
    }
    const hasBody = body.byteLength > 0;

    const timestamp = Date.now();
    const id = await MessageId.make(uaid);

    const ttl = getTtl(request);

    const headers: Record<string, string> = {};
    if (hasBody) {
        const encoding = request.headers.get('content-encoding');
        if (encoding) headers.encoding = encoding;

        const encryption = stripQuotes(request.headers.get('encryption'));
        if (encryption) headers.encryption = encryption;

        const encryption_key = request.headers.get('encryption-key');
        if (encryption_key) headers.encryption_key = encryption_key;

        const crypto_key = stripQuotes(request.headers.get('crypto-key'));
        if (crypto_key) headers.crypto_key = crypto_key;
    }

    headers.ttl = String(ttl);

    const topic = request.headers.get('topic');
    if (topic) headers.topic = topic;

    // TODO: stricter-ish header validation
    const message: StoredMessage = {
        uaid,
        expiresAt: timestamp + ttl * 1000,
        data: {
            messageType: 'notification',
            channelID: chid,
            version: id,
            data: hasBody ? Buf.toBase64Url(body) : undefined,
            headers,
        },
    };

    const status = await Router.route(message);
    if (status === 'full') {
        return new Response(null, {
            status: HTTP.status.TOO_MANY_REQUESTS,
            headers: {
                'Retry-After': '120',
            },
        });
    } else if (status !== 'ok') {
        return new Response(null, {
            status: HTTP.status.SERVICE_UNAVAILABLE,
            headers: {
                'Retry-After': '30',
            },
        });
    }

    return new Response(null, {
        status: HTTP.status.CREATED,
        headers: {
            Ttl: String(ttl),
            Location: getMessageLocation(id),
        },
    });
};

export const handleWebPushDeletion = async (
    request: Request,
    params: URLPatternResult,
) => {
    const maybeError = HTTP.checkMethod(request, 'DELETE');
    if (maybeError) {
        return maybeError;
    }

    const { id } = params.pathname.groups;
    assert(id, 'id missing from url');

    let uaid;
    try {
        uaid = await MessageId.unwrap(id);
    } catch {
        return new Response(null, { status: HTTP.status.NOT_FOUND });
    }

    Router.remove(uaid, id);

    return new Response(null, { status: HTTP.status.NO_CONTENT });
};
