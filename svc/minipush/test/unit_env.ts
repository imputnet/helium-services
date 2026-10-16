// Imported first by unit tests, so that lib/env.ts finds what it needs.
for (const key of ['MINIPUSH_HMAC_SECRET', 'MINIPUSH_ENDPOINT_SECRET']) {
    if (!Deno.env.get(key)) {
        Deno.env.set(key, `unit-test-${key}`);
    }
}
