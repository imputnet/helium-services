import { ed25519 } from 'jsr:@noble/curves/ed25519';
import { decodeBase64, encodeBase64 } from 'jsr:@std/encoding/base64';

import { env } from './env.ts';
import { read, verify } from './assets.ts';

import { Asset } from '../types/assets.ts';

const SIGNING_KEY = decodeBase64(env.edSigningKey);

if (SIGNING_KEY.byteLength !== 32) {
    throw new Error(`ed25519 signing key is not 32 bytes, but ${SIGNING_KEY.byteLength}`);
}

export const signAndVerifyAsset = async (asset: Asset) => {
    await verify(asset);

    const signature = ed25519.sign(await read(asset), SIGNING_KEY);
    return encodeBase64(signature);
};
