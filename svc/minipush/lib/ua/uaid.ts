import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { env } from '../env.ts';
import * as Crypto from '../util/crypto.ts';
import * as Buf from '../util/buffer.ts';

const signingKey = await crypto.subtle.importKey(
    'raw',
    Buf.toBytes(env.hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
);

export const UAID_LEN_UNSIGNED = 12;
export const generate = async () => {
    const unsigned = Crypto.rand(UAID_LEN_UNSIGNED);
    const signature = new Uint8Array(
        await crypto.subtle.sign(
            'HMAC',
            signingKey,
            unsigned,
        ),
    );

    const cat = new Uint8Array(
        unsigned.byteLength + signature.byteLength,
    );
    cat.set(unsigned, 0);
    cat.set(signature, unsigned.byteLength);
    return encodeBase64Url(cat);
};

export const unwrap = async (signed_uaid: string) => {
    const bytes = decodeBase64Url(signed_uaid);
    const uaid_bytes = bytes.subarray(0, UAID_LEN_UNSIGNED);
    const signature = bytes.subarray(UAID_LEN_UNSIGNED);

    if (
        !await crypto.subtle.verify(
            'HMAC',
            signingKey,
            signature,
            uaid_bytes,
        )
    ) {
        throw 'HMAC verification failed';
    }

    return encodeBase64Url(uaid_bytes);
};
