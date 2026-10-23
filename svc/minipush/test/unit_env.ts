// Imported first by unit tests, so that lib/env.ts finds what it needs.
for (const key of ['MINIPUSH_HMAC_SECRET', 'MINIPUSH_ENDPOINT_SECRET']) {
    process.env[key] ||= `unit-test-${key}`;
}
