import { toBase64Url } from './lib/util/buffer.ts';

for (const key of ['MINIPUSH_HMAC_SECRET', 'MINIPUSH_ENDPOINT_SECRET']) {
    console.log(
        `export ${key}=${toBase64Url(
            crypto.getRandomValues(new Uint8Array(12)),
        )}`,
    );
}
