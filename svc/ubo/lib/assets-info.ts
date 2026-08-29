import { env } from './env.ts';

const VERSION_HELIUM = '1.74.0';
const VERSION_VANILLA = '1.74.0';

const CSUM_HELIUM =
    '94d3de3dfccfe953be535961e4108773c5f5797291d69de07f8f1f831a361656';
const CSUM_VANILLA =
    '61488d15d26dfb7a8c73e8e2692ebf636300eb4fb6b98bc8356e317631487996';

const VERSION = env.useHeliumAssets ? VERSION_HELIUM : VERSION_VANILLA;
const REPO = env.useHeliumAssets ? 'imputnet/uBlock' : 'gorhill/uBlock';

if (!env.useHeliumAssets && env.customAssetsChecksum) {
    throw 'USE_ORIGINAL_UBLOCK_ASSETS and UBO_ASSETS_JSON_* '
        + 'cannot be set at the same time';
}

if (!!env.customAssetsUrl !== !!env.customAssetsChecksum) {
    throw 'one of UBO_ASSETS_JSON_{URL,SHA256} is defined, but other'
        + 'is missing';
}

export const fileChecksum = env.customAssetsChecksum
    || (env.useHeliumAssets ? CSUM_HELIUM : CSUM_VANILLA);

export const assetsUrl = env.customAssetsUrl
    || (`https://raw.githubusercontent.com/${REPO}/refs/tags/`
        + `${VERSION}/assets/assets.json`);
