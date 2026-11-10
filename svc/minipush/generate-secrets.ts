import { encodeBase64Url } from '@std/encoding/base64url';

// 32 characters, so that MINIPUSH_ENDPOINT_SECRET is an AES-256 key.
for (
    const key of [
        'MINIPUSH_HMAC_SECRET',
        'MINIPUSH_ENDPOINT_SECRET',
        'MINIPUSH_MESH_SECRET',
    ]
) {
    console.log(
        `export ${key}=${
            encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)))
        }`,
    );
}
