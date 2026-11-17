import { env } from './env.ts';

const VERSION_HELIUM = '1.76.4';
const VERSION_VANILLA = '1.76.4';

const CSUM_HELIUM =
    '07fbdf20c9c1f5212ad6c55d2d7aea1980f4d093fc33e57bf019744dd9694dac';
const CSUM_VANILLA =
    'e994253fe9987f987149bec99bf366e1e3636f166e6acf444bfe0702fc15cfcc';

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
