import { encodeBase64Url } from '@std/encoding/base64url';

for (const key of ['MINIPUSH_HMAC_SECRET', 'MINIPUSH_ENDPOINT_SECRET']) {
    console.log(
        `export ${key}=${
            encodeBase64Url(crypto.getRandomValues(new Uint8Array(12)))
        }`,
    );
}
