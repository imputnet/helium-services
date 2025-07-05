import * as path from 'jsr:@std/path';
import { exists } from 'jsr:@std/fs/exists';
import { decodeHex, encodeHex } from 'jsr:@std/encoding/hex';

import { beq, sleep } from './util.ts';
import { env, headers } from './env.ts';
import { getReleases } from './github.ts';
import { signAndVerifyAsset } from './eddsa.ts';

import { Asset } from '../types/assets.ts';

const pathTo = (asset: Asset) => path.join(env.assetDirectory, asset.name);

export const downloadAsset = async (asset: Asset): Promise<void> => {
    if (asset.name.includes('/')) {
        throw new Error('name contains slashes');
    }

    const response = await fetch(asset.machine_url, {
        headers: {
            ...headers,
            'Accept': 'application/octet-stream',
        },
        redirect: 'follow',
    });

    if (response.status === 429) {
        await sleep(10000);
        return downloadAsset(asset);
    }

    if (!response.ok) {
        console.log(response);
        throw new Error(`response is not ok`);
    }

    const output = await Deno.open(pathTo(asset), {
        createNew: true,
        write: true,
    });

    await response.body!.pipeTo(output.writable);
};

export const hasAsset = (asset: Asset | string) => {
    if (typeof asset === 'object' && 'name' in asset) {
        asset = asset.name;
    }

    return exists(path.join(env.assetDirectory, asset));
};

export const cleanup = async () => {
    const releases = await getReleases();
    const existingFiles = new Set<string>();

    for await (const file of Deno.readDir(env.assetDirectory)) {
        existingFiles.add(file.name);
    }

    const downloadables = releases
        .flatMap((r) => [...Object.values(r.deltas), r.downloads])
        .flatMap((d) => Object.values(d))
        .filter((d) => d !== null);

    for (const asset of downloadables) {
        existingFiles.delete(asset.name);
    }

    for (const file of existingFiles) {
        console.log(`[c] removing ${file}`);
        await Deno.remove(path.join(env.assetDirectory, file));
    }
};

export const read = async (asset: Asset) => {
    return await Deno.readFile(pathTo(asset));
};

export const verify = async (asset: Asset) => {
    const actualDigest = await crypto.subtle.digest(
        'SHA-256',
        await read(asset),
    );

    if (!beq(decodeHex(asset.digest), actualDigest)) {
        throw new Error(
            `digest for ${asset.name} is not matching: ${
                encodeHex(actualDigest)
            } != ${asset.digest}`,
        );
    }
};

export const ensureAssetsReady = async () => {
    const releases = await getReleases();
    const signatures: Promise<void>[] = [];
    const downloadables = releases
        .flatMap((r) => [...Object.values(r.deltas), r.downloads])
        .flatMap((d) => Object.values(d))
        .filter((d) => d !== null);

    for (const asset of downloadables) {
        if (!await hasAsset(asset)) {
            console.log(`[r] missing asset ${asset.name}, downloading...`);
            await downloadAsset(asset);
        }
        signatures.push(signAndVerifyAsset(asset));
    }

    await Promise.all(signatures);
};
