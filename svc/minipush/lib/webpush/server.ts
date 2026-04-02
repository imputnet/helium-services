import { assert } from '@std/assert/assert';
import { unwrap } from './chid.ts';
import { env } from '../env.ts';
import { encodeBase64Url } from '@std/encoding/base64url';
import { NotificationInternal } from './notification.ts';
import * as HTTP from '../util/http.ts';
import * as g_state from '../ua/state.ts';

const getTtl = (req: Request) => {
    const max = env.maxTtlSeconds;

    const ttlStr = req.headers.get('ttl') || '';
    if (!ttlStr) {
        return max;
    }

    const ttl = parseInt(ttlStr, 10);
    if (
        String(ttl) !== ttlStr ||
        !Number.isSafeInteger(ttl) ||
        ttl < 0 ||
        ttl > max
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

    const { uaid, chid } = await unwrap(version, token);
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
    const id = crypto.randomUUID();

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
    const notification: NotificationInternal = {
        data: {
            messageType: 'notification',
            channelID: chid,
            version: id,
            data: hasBody ? encodeBase64Url(body) : undefined,
            headers,
        },
        uaid,
        ttl,
        timestamp,
    };

    if (!g_state.onNewNotification(notification)) {
        return new Response(null, {
            status: 429,
            headers: {
                'Retry-After': '120',
            },
        });
    }

    return new Response(null, {
        status: 201,
        headers: {
            Ttl: String(ttl),
            Location: getMessageLocation(id),
        },
    });
};

export const handleWebPushDeletion = (
    request: Request,
    params: URLPatternResult,
) => {
    const maybeError = HTTP.checkMethod(request, 'DELETE');
    if (maybeError) {
        return maybeError;
    }

    const { id } = params.pathname.groups;
    assert(id, 'id missing from url');
    g_state.onDeleteNotification(id);

    return new Response(null, { status: 204 });
};
