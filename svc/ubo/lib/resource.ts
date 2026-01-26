/// <reference types="@types/node" />
import z from 'node:zlib';

export function compress(s: string) {
    const {
        promise,
        resolve,
        reject,
    } = Promise.withResolvers<ArrayBuffer>();

    z.brotliCompress(s, {
        params: {
            [z.constants.BROTLI_PARAM_MODE]: z.constants.BROTLI_MODE_TEXT,
            [z.constants.BROTLI_PARAM_QUALITY]: 11,
            [z.constants.BROTLI_PARAM_SIZE_HINT]: s.length,
        },
    }, (err, data) => {
        if (err) {
            return reject(err);
        }

        resolve(new Uint8Array(data).buffer);
    });

    return promise;
}

export async function tag(s: string) {
    const buf = await crypto.subtle.digest(
        { name: 'SHA-256' },
        new TextEncoder().encode(s),
    );

    // first 12 bytes should be plenty to ensure no collisions happen
    return ['"', ...new Uint32Array(buf).slice(0, 3), '"']
        .map((a) => a.toString(36)).join('');
}
