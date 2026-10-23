import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';

import { buildApp } from '../src/app.ts';
import { makeTestEnv } from './helpers.ts';
import { checkOrgMembership } from '../src/github.ts';
import { decodeSession, encodeSession } from '../src/session.ts';

test('session payloads round-trip and reject malformed/expired values', () => {
    const now = Date.now();
    const valid = {
        login: 'jj',
        exp: now + 60_000,
    };
    const ok = decodeSession(encodeSession(valid), now);
    assert(ok);
    assert.equal(ok.login, 'jj');

    const rejects = (value: Parameters<typeof decodeSession>[0], at = now) =>
        assert.equal(decodeSession(value, at), null);
    rejects(undefined);
    rejects(false);
    rejects('not json');
    rejects(JSON.stringify({ login: 'jj' }));
    rejects(encodeSession({ ...valid, exp: now - 1 }));
});

function githubMock(membershipState: string | null): typeof fetch {
    return (
        input: string | URL | Request,
        _init?: RequestInit,
    ): Promise<Response> => {
        const url = String(input);
        if (url.startsWith('https://github.com/login/oauth/access_token')) {
            return Promise.resolve(
                Response.json({
                    access_token: 'gho_test',
                    token_type: 'bearer',
                    scope: 'read:org,user:email',
                }),
            );
        }
        if (url === 'https://api.github.com/user') {
            return Promise.resolve(Response.json({ login: 'jj', id: 1 }));
        }
        if (url === 'https://api.github.com/user/emails') {
            return Promise.resolve(
                Response.json([
                    {
                        email: 'jj@example.com',
                        primary: true,
                        verified: true,
                    },
                ]),
            );
        }
        if (url.startsWith('https://api.github.com/user/memberships/orgs/')) {
            if (membershipState === null) {
                return Promise.resolve(
                    Response.json({ message: 'Not Found' }, { status: 404 }),
                );
            }
            return Promise.resolve(Response.json({ state: membershipState }));
        }
        return Promise.resolve(new Response('unexpected', { status: 500 }));
    };
}

async function withGlobalFetch(
    mock: typeof fetch,
    fn: () => Promise<void>,
): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = mock;
    try {
        await fn();
    } finally {
        globalThis.fetch = original;
    }
}

test('checkOrgMembership only accepts active membership', async () => {
    assert.deepStrictEqual(
        await checkOrgMembership(githubMock('active'), 't', 'test-org'),
        true,
    );
    assert.deepStrictEqual(
        await checkOrgMembership(githubMock('pending'), 't', 'test-org'),
        false,
    );
    assert.deepStrictEqual(
        await checkOrgMembership(githubMock(null), 't', 'test-org'),
        false,
    );
});

test('login entry redirects to GitHub and sets a state cookie', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const res = await app.request('/auth/callback');
        assert.equal(res.status, 302);
        const location = res.headers.get('location') ?? '';
        assert(
            location.startsWith('https://github.com/login/oauth/authorize?'),
        );
        assert(location.includes('client_id=test-client-id'));
        assert((res.headers.get('set-cookie') ?? '').includes('state='));
    } finally {
        await env.cleanup();
    }
});

test('OAuth callback grants a session to active org members', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({
            config: env.config,
            db: env.db,
            githubFetch: githubMock('active'),
        });
        await withGlobalFetch(githubMock('active'), async () => {
            const res = await app.request('/auth/callback?code=abc&state=st1', {
                headers: { cookie: 'state=st1' },
            });
            assert.equal(res.status, 302);
            assert.equal(res.headers.get('location'), '/');
            const setCookie = res.headers.get('set-cookie') ?? '';
            assert(setCookie.includes('session='));
            assert(setCookie.includes('Max-Age=604800'));
            assert(setCookie.includes('HttpOnly'));
            assert(setCookie.includes('SameSite=Lax'));

            // The issued (signed) session cookie opens the UI.
            const sessionValue = /session=([^;]+)/.exec(setCookie)![1];
            const home = await app.request('/', {
                headers: { cookie: `session=${sessionValue}` },
            });
            assert.equal(home.status, 200);
            assert.deepStrictEqual(
                home.headers
                    .get('content-security-policy')
                    ?.includes("script-src 'self' 'unsafe-inline'"),
                false,
            );
            const homeHtml = await home.text();
            assert(homeHtml.includes('minidumpster'));
            assert(
                homeHtml.includes(
                    '<script src="/static/app.js" defer></script>',
                ),
            );
            assert.equal(homeHtml.includes('<script>'), false);

            env.db.registerArtifact(
                'imputnet/helium-windows',
                42,
                '0.14.5.1',
                'build-artifact-arm64',
            );
            env.db.markArtifactIngested(
                'imputnet/helium-windows',
                42,
                1,
                Date.now(),
            );
            await mkdir(`${env.dir}/symbols/bundles`, { recursive: true });
            await writeFile(`${env.dir}/symbols/bundles/helium-0.14.5.1`, '');
            const symbols = await app.request('/symbols', {
                headers: { cookie: `session=${sessionValue}` },
            });
            assert.equal(symbols.status, 200);
            const symbolsHtml = await symbols.text();
            assert(symbolsHtml.includes('build-artifact-arm64'));
            assert(symbolsHtml.includes('symbols installed'));

            // A tampered signature is rejected.
            const tampered = await app.request('/', {
                headers: { cookie: `session=${sessionValue}x` },
            });
            assert.equal(tampered.status, 302);
            assert.equal(tampered.headers.get('location'), '/auth/login');
        });
    } finally {
        await env.cleanup();
    }
});

test('OAuth callback rejects non-members with 403', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({
            config: env.config,
            db: env.db,
            githubFetch: githubMock(null),
        });
        await withGlobalFetch(githubMock(null), async () => {
            const res = await app.request('/auth/callback?code=abc&state=st1', {
                headers: { cookie: 'state=st1' },
            });
            assert.equal(res.status, 403);
            assert((await res.text()).includes('not an active member'));
        });
    } finally {
        await env.cleanup();
    }
});

test('OAuth callback rejects state mismatches', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        await withGlobalFetch(githubMock('active'), async () => {
            const res = await app.request(
                '/auth/callback?code=abc&state=evil',
                {
                    headers: { cookie: 'state=st1' },
                },
            );
            assert.equal(res.status, 401);
            await res.body?.cancel();
        });
    } finally {
        await env.cleanup();
    }
});

test('UI routes redirect to login without a session', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        for (const path of [
            '/',
            '/symbols',
            '/groups/1',
            '/reports/x',
            '/reports/x/dump',
        ]) {
            const res = await app.request(path);
            assert.deepStrictEqual(
                res.status,
                302,
                `expected redirect for ${path}`,
            );
            assert.equal(res.headers.get('location'), '/auth/login');
        }
    } finally {
        await env.cleanup();
    }
});

test('shared page assets are served without a session', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });

        const res = await app.request('/static/style.css');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert(
            (res.headers.get('content-security-policy') ?? '').includes(
                "default-src 'none'",
            ),
        );
        assert(
            (res.headers.get('content-security-policy') ?? '').includes(
                "script-src 'self'",
            ),
        );
        assert.deepStrictEqual(
            res.headers
                .get('content-security-policy')
                ?.includes("script-src 'self' 'unsafe-inline'"),
            false,
        );
        assert.deepStrictEqual(
            res.headers.get('content-type'),
            'text/css; charset=utf-8',
        );
        assert((await res.text()).includes('.expandable'));

        const favicon = await app.request('/static/favicon.svg');
        assert.equal(favicon.status, 200);
        assert.deepStrictEqual(
            favicon.headers.get('content-type'),
            'image/svg+xml; charset=utf-8',
        );
        assert((await favicon.text()).startsWith('<svg'));

        const script = await app.request('/static/app.js');
        assert.equal(script.status, 200);
        assert.deepStrictEqual(
            script.headers.get('content-type'),
            'text/javascript; charset=utf-8',
        );
        assert((await script.text()).includes('addEventListener'));

        // Everything else stays gated.
        const page = await app.request('/');
        assert.equal(page.status, 302);
        assert.equal(page.headers.get('location'), '/auth/login');
    } finally {
        await env.cleanup();
    }
});
