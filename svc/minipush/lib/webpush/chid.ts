import { env } from '../env.ts';
import * as Uuid from '../util/uuid.ts';
import * as Buf from '../util/buffer.ts';
import * as Crypto from '../util/crypto.ts';
import { UAID_LEN_UNSIGNED } from '../ua/uaid.ts';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';

const BASE_WITH_TRAILING_SLASH = (() => {
    const url = new URL(env.baseUrl);
    if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
    }

    url.hash = '';
    url.search = '';

    return url;
})();

const encryptionKey = await crypto.subtle.importKey(
    'raw',
    Buf.toBytes(env.endpointSecret),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
);

const CHID_LEN = 16;
const SHA256_LEN = 32;

export const makeEndpoint = async (
    uaid: string,
    chid: string,
    key?: string,
) => {
    const url = new URL(BASE_WITH_TRAILING_SLASH);
    url.pathname += 'wpush';
    url.pathname += key ? '/v2/' : '/v1/';

    const iv = Crypto.rand(CHID_LEN);
    const plain = Buf.cat(
        decodeBase64Url(uaid),
        Uuid.toBytes(chid),
        key ? await Crypto.sha256(decodeBase64Url(key)) : new Uint8Array(),
    );

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        plain,
    );

    url.pathname += encodeBase64Url(Buf.cat(encrypted, iv));
    return url.toString();
};

const unwrapFromBytes = async (
    version: 'v1' | 'v2',
    bytes: Uint8Array<ArrayBuffer>,
) => {
    const data = bytes.subarray(0, bytes.length - 16);
    const iv = bytes.subarray(bytes.length - 16);

    const plain = new Uint8Array(
        await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            encryptionKey,
            data,
        ),
    );

    const [uaidBytes, chidBytes, keyBytes] = Buf.split(
        plain.buffer,
        [UAID_LEN_UNSIGNED, CHID_LEN, SHA256_LEN],
    );

    const chid = Uuid.fromBytes(chidBytes);
    const uaid = encodeBase64Url(uaidBytes);
    let vapidKey;

    if (version === 'v2') {
        if (keyBytes.byteLength === 0) {
            throw 'v2 format is missing vapid key';
        }

        vapidKey = encodeBase64Url(keyBytes);
    } else if (version === 'v1' && keyBytes.byteLength > 0) {
        throw 'v1 format has unexpected key';
    }

    return {
        uaid,
        chid,
        vapidKey,
    };
};

export const unwrap = (version: string, token: string) => {
    if (version !== 'v1' && version !== 'v2') {
        throw `invalid version: ${version}`;
    }

    const bytes = decodeBase64Url(token);
    return unwrapFromBytes(version, bytes);
};
