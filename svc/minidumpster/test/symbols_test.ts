import { assertEquals, assertRejects } from '@std/assert';

import { buildApp } from '../src/app.ts';
import { makeTestEnv } from './helpers.ts';
import { _test } from '../src/symbols.ts';

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
        assertEquals(await anon.json(), {
            ok: false,
            error: 'missing or invalid bearer token',
        });

        const wrong = await app.request(
            '/api/symbols?product=mybrowser&version=1.0.0',
            {
                method: 'POST',
                headers: { authorization: 'Bearer nope' },
                body: new Uint8Array([1, 2, 3]),
            },
        );
        assertEquals(wrong.status, 401);
        assertEquals(await wrong.json(), {
            ok: false,
            error: 'missing or invalid bearer token',
        });

        const malformed = await app.request(
            '/api/symbols?product=mybrowser&version=1.0.0',
            {
                method: 'POST',
                headers: { authorization: 'not bearer' },
                body: new Uint8Array([1, 2, 3]),
            },
        );
        assertEquals(malformed.status, 400);
        assertEquals(await malformed.json(), {
            ok: false,
            error: 'missing or invalid bearer token',
        });
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
        const body = (await res.json()) as { error: string };
        assertEquals(body.error.includes('product'), true);
    } finally {
        await env.cleanup();
    }
});

Deno.test('symsorter enforces a timeout', async () => {
    await assertRejects(
        () =>
            _test.runSymsorter(
                Deno.execPath(),
                ['eval', 'await new Promise(r => setTimeout(r, 5000))'],
                50,
            ),
        Error,
        'symsorter exceeded timeout',
    );
});
