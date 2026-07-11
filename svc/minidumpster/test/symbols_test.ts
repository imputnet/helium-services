import { assertEquals } from '@std/assert';

import { buildApp } from '../src/app.ts';
import { makeTestEnv } from './helpers.ts';

Deno.test('POST /api/symbols requires the bearer token', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const anon = await app.request(
            '/api/symbols?product=mybrowser&version=1.0.0',
            {
                method: 'POST',
                body: new Uint8Array([1, 2, 3]),
            },
        );
        assertEquals(anon.status, 401);
        await anon.body?.cancel();

        const wrong = await app.request(
            '/api/symbols?product=mybrowser&version=1.0.0',
            {
                method: 'POST',
                headers: { authorization: 'Bearer nope' },
                body: new Uint8Array([1, 2, 3]),
            },
        );
        assertEquals(wrong.status, 401);
        await wrong.body?.cancel();
    } finally {
        await env.cleanup();
    }
});

Deno.test('POST /api/symbols requires product and version', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const res = await app.request('/api/symbols?version=1.0.0', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${env.config.symbolUploadToken}`,
            },
            body: new Uint8Array([1, 2, 3]),
        });
        assertEquals(res.status, 400);
        const body = await res.json() as { error: string };
        assertEquals(body.error.includes('product'), true);
    } finally {
        await env.cleanup();
    }
});
