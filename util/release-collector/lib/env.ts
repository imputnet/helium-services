const strictGet = (name: string) => {
    const val = Deno.env.get(name);
    if (typeof val !== 'string') {
        throw new Error(`env ${name} is missing`);
    }

    return val;
};

export const env = {
    outPath: strictGet('OUTPUT_JSON_PATH'),
    githubAccessToken: Deno.env.get('GITHUB_ACCESS_TOKEN'),
};

export const headers: Record<string, string> = {};

if (env.githubAccessToken) {
    headers.authorization = `Bearer ${env.githubAccessToken}`;
}
