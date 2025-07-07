import { join } from 'jsr:@std/path/join';
import { exists } from 'jsr:@std/fs/exists';
import { ed25519 } from 'jsr:@noble/curves/ed25519';
import { decodeBase64, encodeBase64 } from 'jsr:@std/encoding/base64';

import { env } from './env.ts';
import { read, verify } from './assets.ts';

import { Asset } from '../types/assets.ts';

const SIGNING_KEY = decodeBase64(env.edSigningKey);

if (SIGNING_KEY.byteLength !== 32) {
    throw new Error(`ed25519 signing key is not 32 bytes, but ${SIGNING_KEY.byteLength}`);
}

const sigFile = join(env.appcastDirectory, 'signatures.json');
const sigCache: Record<string, /* filename */ string /* b64_sig */> = {};

if (await exists(sigFile)) {
    Object.assign(sigCache, JSON.parse(await Deno.readTextFile(sigFile)));
}

const write = () => Deno.writeTextFile(sigFile, JSON.stringify(sigCache, null, 4));

export const signAndVerifyAsset = async (asset: Asset) => {
    if (sigCache[asset.name]) {
        return;
    }

    await verify(asset);

    const signature = ed25519.sign(await read(asset), SIGNING_KEY);
    sigCache[asset.name] = encodeBase64(signature);
    await write();
};

export const removeSignatureForFile = async (filename: string) => {
    if (!sigCache[filename]) {
        return;
    }

    delete sigCache[filename];
    await write();
};

export const getSignatureFor = async (asset: Asset) => {
    if (!sigCache[asset.name]) {
        await signAndVerifyAsset(asset);
    }

    return sigCache[asset.name];
};
