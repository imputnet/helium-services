import { assert, assertEquals } from '@std/assert';
import { serializeSigned } from 'hono/utils/cookie';

import { buildApp } from '../src/app.ts';
import { dumpPath } from '../src/paths.ts';
import { processReport } from '../src/worker.ts';
import { makeTestEnv, type TestEnv } from './helpers.ts';

async function sessionCookie(env: TestEnv): Promise<string> {
    const value = JSON.stringify({ login: 'jj', exp: Date.now() + 60_000 });
    const cookie = await serializeSigned(
        'session',
        value,
        env.config.sessionSecret,
    );
    return cookie.split(';')[0];
}

function fixture(): Promise<string> {
    return Deno.readTextFile(
        new URL('./fixtures/apple_report.txt', import.meta.url),
    );
}

function appleFixtureResponse(): Promise<string> {
    return Deno.readTextFile(
        new URL(
            './fixtures/symbolicator_apple_completed.json',
            import.meta.url,
        ),
    );
}

Deno.test('pasted Apple crash reports are filed and deduped by incident id', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await sessionCookie(env);
        const form = new FormData();
        form.append('text', await fixture());
        const res = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: form,
        });
        assertEquals(res.status, 302);
        const location = res.headers.get('location')!;
        assert(location.startsWith('/reports/'));
        const id = location.slice('/reports/'.length);

        const row = env.db.getReport(id)!;
        assertEquals(row.kind, 'apple');
        assertEquals(row.status, 'pending');
        assertEquals(row.product, 'Helium');
        assertEquals(row.version, '0.14.3.1');
        assertEquals(row.guid, '893ED25D-2D48-4068-9451-7BB173D52BDD');
        const annotations = JSON.parse(row.annotations) as Record<
            string,
            string
        >;
        assertEquals(annotations['uploaded_by'], 'jj');
        assertEquals(annotations['bundle_id'], 'net.imput.helium');
        const stored = await Deno.readTextFile(dumpPath(env.dir, id));
        assert(stored.includes('Thread 0 Crashed'));

        // Same incident again → redirected to the existing report.
        const again = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: (() => {
                const f = new FormData();
                f.append('text', stored);
                return f;
            })(),
        });
        assertEquals(again.status, 302);
        assertEquals(again.headers.get('location'), `/reports/${id}`);
    } finally {
        await env.cleanup();
    }
});

Deno.test('upload rejects non-crash-report input and requires a session', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await sessionCookie(env);

        const form = new FormData();
        form.append('text', '{"app_name":"Helium","bug_type":"309"}');
        const bad = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: form,
        });
        assertEquals(bad.status, 400);
        assert((await bad.text()).includes('does not look like'));

        const anon = await app.request('/upload', { method: 'POST' });
        assertEquals(anon.status, 302);
        assertEquals(anon.headers.get('location'), '/auth/login');
    } finally {
        await env.cleanup();
    }
});

Deno.test('worker symbolicates Apple reports via /applecrashreport', async () => {
    const appleResponse = await appleFixtureResponse();
    let normalizedSeen = '';
    const server = Deno.serve(
        { port: 0, onListen: () => {} },
        async (req) => {
            const url = new URL(req.url);
            if (req.method === 'POST' && url.pathname === '/applecrashreport') {
                const form = await req.formData();
                const part = form.get('apple_crash_report');
                normalizedSeen = part instanceof File ? await part.text() : '';
                return new Response(appleResponse, {
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response('wrong endpoint', { status: 404 });
        },
    );
    const env = await makeTestEnv({
        symbolicatorUrl: `http://127.0.0.1:${server.addr.port}`,
    });
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await sessionCookie(env);
        const form = new FormData();
        form.append('text', await fixture());
        const res = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: form,
        });
        const id = res.headers.get('location')!.slice('/reports/'.length);

        const [claimed] = env.db.claimPending(1, Date.now());
        assertEquals(claimed.id, id);
        await processReport(
            { db: env.db, config: env.config, pollIntervalMs: 5 },
            claimed,
        );

        // The worker sent the normalized (classic-format) report.
        assert(normalizedSeen.includes('net.imput.helium.framework arm64'));
        assert(!normalizedSeen.includes('Full Report'));

        const row = env.db.getReport(id)!;
        assertEquals(row.status, 'processed');
        assertEquals(row.platform, 'macOS');
        const group = env.db.getGroup(row.group_id!)!;
        // Product hint keeps Helium frames; the CHECK-machinery top frame
        // (logging::LogMessage::~LogMessage) is skipped as a sentinel.
        assertEquals(
            group.title,
            'content::RenderWidgetHostImpl::OnKeyboardEvent()',
        );

        // The report page shows product, version, and platform.
        const page = await app.request(`/reports/${id}`, {
            headers: { cookie },
        });
        assertEquals(page.status, 200);
        const html = await page.text();
        assert(html.includes('Helium 0.14.3.1'));
        assert(html.includes('macOS'));
    } finally {
        await server.shutdown();
        await env.cleanup();
    }
});

Deno.test('search finds reports by id, id prefix, and guid', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await sessionCookie(env);
        const id = crypto.randomUUID();
        const guid = 'D41D8CD9-8F00-B204-E980-0998ECF8427E';
        env.db.insertReport({
            id,
            product: 'Helium',
            version: '0.14.3.1',
            guid,
            ptype: null,
            channel: null,
            annotations: '{}',
            received_at: Date.now(),
        });

        // Full id → direct redirect (case-insensitive).
        const byId = await app.request(
            `/search?q=${id.toUpperCase()}`,
            { headers: { cookie } },
        );
        assertEquals(byId.status, 302);
        assertEquals(byId.headers.get('location'), `/reports/${id}`);

        // 8-char prefix, as shown in the UI → redirect.
        const byPrefix = await app.request(`/search?q=${id.slice(0, 8)}`, {
            headers: { cookie },
        });
        assertEquals(byPrefix.status, 302);
        assertEquals(byPrefix.headers.get('location'), `/reports/${id}`);

        // Guid (lowercased by the user) → redirect.
        const byGuid = await app.request(
            `/search?q=${guid.toLowerCase()}`,
            { headers: { cookie } },
        );
        assertEquals(byGuid.status, 302);
        assertEquals(byGuid.headers.get('location'), `/reports/${id}`);

        // No match → results page, not an error.
        const none = await app.request('/search?q=ffffffff', {
            headers: { cookie },
        });
        assertEquals(none.status, 200);
        assert((await none.text()).includes('No reports match'));

        // Too-short queries are rejected.
        const short = await app.request('/search?q=ab', {
            headers: { cookie },
        });
        assertEquals(short.status, 400);
        await short.body?.cancel();
    } finally {
        await env.cleanup();
    }
});
