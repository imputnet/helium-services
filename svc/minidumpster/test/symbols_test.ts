import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.ts';
import { makeTestEnv } from './helpers.ts';
import { _test } from '../src/symbols.ts';

test('POST /api/symbols requires the bearer token', async () => {
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
        assert.equal(anon.status, 401);
        assert.deepStrictEqual(await anon.json(), {
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
        assert.equal(wrong.status, 401);
        assert.deepStrictEqual(await wrong.json(), {
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
        assert.equal(malformed.status, 400);
        assert.deepStrictEqual(await malformed.json(), {
            ok: false,
            error: 'missing or invalid bearer token',
        });
    } finally {
        await env.cleanup();
    }
});

test('POST /api/symbols requires product and version', async () => {
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
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error.includes('product'), true);
    } finally {
        await env.cleanup();
    }
});

test('symsorter enforces a timeout', async () => {
    await assert.rejects(
        () =>
            _test.runSymsorter(
                process.execPath,
                ['-e', 'setTimeout(() => {}, 5000)'],
                50,
            ),
        { message: /symsorter exceeded timeout/ },
    );
});
