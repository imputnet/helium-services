import { env } from './env.ts';

const VERSION_HELIUM = '1.73.0';
const VERSION_VANILLA = '1.73.0';

const CSUM_HELIUM =
    '8223523350062ecc8406265fbf2dfbf22aede1b5e3d1e1f83c311cec4db36076';
const CSUM_VANILLA =
    'fff077d6a1f5522170fa343008e18a4e41228fae8dd5abe5796191f7f3400b17';

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
