const strictGet = (name: string) => {
    const val = Deno.env.get(name);
    if (typeof val !== 'string') {
        throw new Error(`env ${name} is missing`);
    }

    return val;
};

const getBool = (name: string) => {
    const val = Deno.env.get(name) || '';
    return ['true', 'yes', 'on', 't', 'y', '1'].includes(val.toLowerCase());
};

export const env = {
    baseURL: strictGet('UBO_PROXY_BASE_URL'),
    useHeliumAssets: !getBool('USE_ORIGINAL_UBLOCK_ASSETS'),
};
