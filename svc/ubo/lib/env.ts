const strictGet = (name: string) => {
    const val = Deno.env.get(name);
    if (typeof val !== 'string') {
        throw new Error(`env ${name} is missing`);
    }

    return val;
};

const getBool = (name: string) => {
    const val = Deno.env.get(name) || '';
    return ['true', 'yes', 'on', 't', 'y', '1'].includes(
        val.toLowerCase(),
    );
};

const getUrl = (name: string) => {
    const val = Deno.env.get(name);
    if (val) {
        return new URL(val);
    }
};

export const env = {
    baseURL: strictGet('UBO_PROXY_BASE_URL'),
    useHeliumAssets: !getBool('UBO_USE_ORIGINAL_UBLOCK_ASSETS'),
    customAssetsUrl: getUrl('UBO_ASSETS_JSON_URL'),
    customAssetsChecksum: Deno.env.get('UBO_ASSETS_JSON_SHA256'),
};
