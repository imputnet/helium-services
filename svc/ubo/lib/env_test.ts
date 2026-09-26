// env.ts reads its environment on import, so set it first
Deno.env.set('UBO_PROXY_BASE_URL', 'https://services.domain.invalid/ubo');
const { env, withTrailingSlash } = await import('./env.ts');

const expected = 'https://services.domain.invalid/ubo/ublock-badlists/list.txt';
const assertListUrl = (base: string) => {
    const url = new URL('ublock-badlists/list.txt', base).toString();
    if (url !== expected) {
        throw new Error(`base ${base} resolves lists to ${url}`);
    }
};

Deno.test('list URLs keep /ubo/ with or without a trailing slash', () => {
    assertListUrl(withTrailingSlash('https://services.domain.invalid/ubo'));
    assertListUrl(withTrailingSlash('https://services.domain.invalid/ubo/'));
});

Deno.test('env.baseURL is normalised', () => {
    assertListUrl(env.baseURL);
});
