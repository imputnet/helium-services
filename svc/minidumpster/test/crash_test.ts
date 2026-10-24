import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { buildApp } from '../src/app.ts';
import { dumpPath } from '../src/paths.ts';
import { encodeMultipart, gzipBytes, makeTestEnv } from './helpers.ts';

// The bindings @hono/node-server hands app.fetch for an unproxied connection;
// app.request() forwards them as c.env, where getConnInfo() reads them.
const directConn = {
    incoming: {
        socket: {
            remoteAddress: '203.0.113.9',
            remotePort: 51234,
            remoteFamily: 'IPv4',
        },
    },
} as const;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function crashpadForm(dump: Uint8Array): FormData {
    const form = new FormData();
    form.append('prod', 'MyBrowser');
    form.append('ver', '138.0.1.0');
    form.append('guid', 'd41d8cd9-8f00-b204-e980-0998ecf8427e');
    form.append('ptype', 'renderer');
    form.append('channel', 'stable');
    form.append('switch-1', '--type=renderer');
    form.append(
        'upload_file_minidump',
        new Blob([dump.slice()], { type: 'application/octet-stream' }),
        'dump',
    );
    return form;
}

test('POST /crash accepts a gzipped Crashpad multipart upload', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const dump = new Uint8Array(4096).fill(0x4d); // "MDMP"-ish filler
        dump.set([0x4d, 0x44, 0x4d, 0x50], 0);
        const { bytes, contentType } = await encodeMultipart(
            crashpadForm(dump),
        );
        const gz = await gzipBytes(bytes);

        const res = await app.request(
            '/crash',
            {
                method: 'POST',
                headers: {
                    'content-type': contentType,
                    'content-encoding': 'gzip',
                },
                body: gz,
            },
            directConn,
        );
        assert.equal(res.status, 200);
        const id = (await res.text()).trim();
        assert.match(id, UUID_RE);

        const written = new Uint8Array(await readFile(dumpPath(env.dir, id)));
        assert.deepStrictEqual(written, dump);

        const row = env.db.getReport(id);
        assert(row);
        assert.equal(row.status, 'pending');
        assert.equal(row.product, 'MyBrowser');
        assert.equal(row.version, '138.0.1.0');
        assert.equal(row.ptype, 'renderer');
        assert.equal(row.channel, 'stable');
        const annotations = JSON.parse(row.annotations) as Record<
            string,
            string
        >;
        assert.equal(annotations['switch-1'], '--type=renderer');
    } finally {
        await env.cleanup();
    }
});

test('POST /crash accepts an uncompressed multipart upload', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const dump = new Uint8Array([1, 2, 3, 4, 5]);
        const { bytes, contentType } = await encodeMultipart(
            crashpadForm(dump),
        );
        const res = await app.request(
            '/crash',
            {
                method: 'POST',
                headers: { 'content-type': contentType },
                body: bytes,
            },
            directConn,
        );
        assert.equal(res.status, 200);
        assert.match((await res.text()).trim(), UUID_RE);
    } finally {
        await env.cleanup();
    }
});

test('POST /crash rejects non-multipart bodies', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const res = await app.request(
            '/crash',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ nope: true }),
            },
            directConn,
        );
        assert.equal(res.status, 415);
        await res.body?.cancel();
    } finally {
        await env.cleanup();
    }
});

test('POST /crash rejects multipart without upload_file_minidump', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const form = new FormData();
        form.append('prod', 'MyBrowser');
        const { bytes, contentType } = await encodeMultipart(form);
        const res = await app.request(
            '/crash',
            {
                method: 'POST',
                headers: { 'content-type': contentType },
                body: bytes,
            },
            directConn,
        );
        assert.equal(res.status, 400);
        await res.body?.cancel();
    } finally {
        await env.cleanup();
    }
});

test('POST /crash enforces the max body size', async () => {
    const env = await makeTestEnv({ maxDumpSizeBytes: 1024 });
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const { bytes, contentType } = await encodeMultipart(
            crashpadForm(new Uint8Array(8192)),
        );
        const res = await app.request(
            '/crash',
            {
                method: 'POST',
                headers: { 'content-type': contentType },
                body: bytes,
            },
            directConn,
        );
        assert.equal(res.status, 413);
        await res.body?.cancel();
    } finally {
        await env.cleanup();
    }
});

test('POST /crash with no attributable client address is an error', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const { bytes, contentType } = await encodeMultipart(
            crashpadForm(new Uint8Array([1, 2, 3])),
        );

        // No x-forwarded-for and no connection info: the rate limiter must
        // refuse to guess a bucket key.
        const res = await app.request('/crash', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: bytes,
        });
        assert.equal(res.status, 500);
        await res.body?.cancel();
    } finally {
        await env.cleanup();
    }
});

test('POST /crash rate limits per client IP', async () => {
    const env = await makeTestEnv({ rateLimitPerMinute: 2 });
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const dump = new Uint8Array([1, 2, 3]);
        const { bytes, contentType } = await encodeMultipart(
            crashpadForm(dump),
        );
        const post = (ip: string) =>
            app.request('/crash', {
                method: 'POST',
                headers: { 'content-type': contentType, 'x-forwarded-for': ip },
                body: bytes,
            });
        assert.equal((await post('1.2.3.4')).status, 200);
        assert.equal((await post('1.2.3.4')).status, 200);
        const limited = await post('1.2.3.4');
        assert.equal(limited.status, 429);
        await limited.body?.cancel();
        // A different client is unaffected.
        assert.equal((await post('5.6.7.8')).status, 200);
    } finally {
        await env.cleanup();
    }
});
