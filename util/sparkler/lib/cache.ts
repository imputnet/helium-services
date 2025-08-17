import { signAndVerifyAsset } from './eddsa.ts';
import { getMinimumSystemVersionFor } from './dmg.ts';
import { getSignaturesAndVersions } from './appcast.ts';

import { Asset } from '../types/assets.ts';

const _signatureCache: Record<string, string> = {};
const _minimumVersionCache: Record<string, string> = {};

export const loadExistingAppcast = async (path: string) => {
    const fileInfo = await getSignaturesAndVersions(path);

    for (const { filename, ...meta } of fileInfo) {
        _signatureCache[filename] = meta.signature;

        if ('minVersion' in meta) {
            _minimumVersionCache[filename] = meta.minVersion;
        }
    }
};

export const getSignature = async (asset: Asset) => {
    _signatureCache[asset.name] ??= await signAndVerifyAsset(asset);
    return _signatureCache[asset.name];
};

export const getMinimumVersion = async (asset: Asset) => {
    _minimumVersionCache[asset.name] ??= await getMinimumSystemVersionFor(asset);
    return _minimumVersionCache[asset.name];
};
