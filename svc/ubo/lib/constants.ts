import { env } from './env.ts';

const VERSION_HELIUM = '1.68.1rc2';
const VERSION_VANILLA = '1.68.0';

const CSUM_HELIUM =
    'e1b8fe8fca5f81d1bfb9e149b82dfb077624329f4e4a75603dd7d23534ea142d';
const CSUM_VANILLA =
    'cad897c8cbf81b0fce2a08a5382baee9397c6563a6391329030aa52864c329ca';

const VERSION = env.useHeliumAssets ? VERSION_HELIUM : VERSION_VANILLA;
const REPO = env.useHeliumAssets ? 'imputnet/uBlock' : 'gorhill/uBlock';

export const FILE_CHECKSUM = env.useHeliumAssets ? CSUM_HELIUM : CSUM_VANILLA;
export const ASSET_URL =
    `https://raw.githubusercontent.com/${REPO}/refs/tags/${VERSION}/assets/assets.json`;
