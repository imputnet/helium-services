import { bool, optional, required, url } from '@helium-services/common/env';

export const env = {
    baseURL: required('UBO_PROXY_BASE_URL'),
    useHeliumAssets: !bool('UBO_USE_ORIGINAL_UBLOCK_ASSETS'),
    customAssetsUrl: url('UBO_ASSETS_JSON_URL'),
    customAssetsChecksum: optional('UBO_ASSETS_JSON_SHA256'),
};
