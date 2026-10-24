import { bool, required } from '@helium-services/common/env';

export const env = {
    githubRepo: required('GITHUB_REPO'),
    assetDirectory: required('ASSETS_DIR'),
    edSigningKey: required('ED_PRIVATE_KEY'),
    appcastDirectory: required('APPCAST_PUBLIC_DIR'),
    shouldServeAssets: bool('SERVE_ASSETS_LOCALLY'),
};
