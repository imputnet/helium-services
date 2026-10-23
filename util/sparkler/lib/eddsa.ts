import { ed25519 } from '@noble/curves/ed25519.js';

import { env } from './env.ts';
import { read, verify } from './assets.ts';

import type { Asset } from '../types/assets.ts';

const SIGNING_KEY = Buffer.from(env.edSigningKey, 'base64');

if (SIGNING_KEY.byteLength !== 32) {
    throw new Error(
        `ed25519 signing key is not 32 bytes, but ${SIGNING_KEY.byteLength}`,
    );
}

export const signAndVerifyAsset = async (asset: Asset) => {
    await verify(asset);

    const signature = ed25519.sign(await read(asset), SIGNING_KEY);
    return Buffer.from(signature).toString('base64');
};
