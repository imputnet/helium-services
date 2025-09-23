const strictGet = (name: string) => {
    const val = Deno.env.get(name);
    if (typeof val !== 'string') {
        throw new Error(`env ${name} is missing`);
    }

    return val;
};

export const env = {
    baseURL: strictGet('UBO_PROXY_BASE_URL'),
};
