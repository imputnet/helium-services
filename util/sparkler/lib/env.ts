const strictGet = (name: string) => {
    const val = Deno.env.get(name);
    if (typeof val !== 'string') {
        throw new Error(`env ${name} is missing`);
    }

    return val;
};

const getBool = (name: string) => {
    const val = Deno.env.get(name);
    return typeof val === 'string' && ['1', 'true', 'yes'].includes(val.toLowerCase());
};

export const env = {
    githubRepo: strictGet('GITHUB_REPO'),
    assetDirectory: strictGet('ASSETS_DIR'),
    githubAccessToken: Deno.env.get('GITHUB_ACCESS_TOKEN'),
    edSigningKey: strictGet('ED_PRIVATE_KEY'),
    appcastDirectory: strictGet('APPCAST_PUBLIC_DIR'),
    shouldServeAssets: getBool('SERVE_ASSETS_LOCALLY'),
};

export const headers: Record<string, string> = {};

if (env.githubAccessToken) {
    headers.authorization = `Bearer ${env.githubAccessToken}`;
}
