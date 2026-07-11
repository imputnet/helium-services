import { assert, assertEquals } from '@std/assert';

import { buildApp } from '../src/app.ts';
import { makeTestEnv } from './helpers.ts';
import { checkOrgMembership } from '../src/github.ts';
import { decodeSession, encodeSession } from '../src/session.ts';

Deno.test('session payloads round-trip and reject malformed/expired values', () => {
    const now = Date.now();
    const ok = decodeSession(
        encodeSession({ login: 'jj', exp: now + 60_000 }),
        now,
    );
    assert(ok);
    assertEquals(ok.login, 'jj');

    assertEquals(decodeSession(undefined, now), null);
    assertEquals(decodeSession(false, now), null);
    assertEquals(decodeSession('not json', now), null);
    assertEquals(decodeSession(JSON.stringify({ login: 'jj' }), now), null);
    assertEquals(
        decodeSession(encodeSession({ login: 'jj', exp: now - 1 }), now),
        null,
    );
});

/** Mock of the GitHub endpoints hit during login (middleware + org gate). */
function githubMock(membershipState: string | null): typeof fetch {
    return (
        input: URL | RequestInfo,
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
                Response.json([{
                    email: 'jj@example.com',
                    primary: true,
                    verified: true,
                }]),
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

/** The oauth middleware uses global fetch — stub it for the duration of fn. */
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

Deno.test('checkOrgMembership only accepts active membership', async () => {
    assertEquals(
        await checkOrgMembership(githubMock('active'), 't', 'test-org'),
        true,
    );
    assertEquals(
        await checkOrgMembership(githubMock('pending'), 't', 'test-org'),
        false,
    );
    assertEquals(
        await checkOrgMembership(githubMock(null), 't', 'test-org'),
        false,
    );
});

Deno.test('login entry redirects to GitHub and sets a state cookie', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const res = await app.request('/auth/callback');
        assertEquals(res.status, 302);
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

Deno.test('OAuth callback grants a session to active org members', async () => {
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
            assertEquals(res.status, 302);
            assertEquals(res.headers.get('location'), '/');
            const setCookie = res.headers.get('set-cookie') ?? '';
            assert(setCookie.includes('session='));

            // The issued (signed) session cookie opens the UI.
            const sessionValue = /session=([^;]+)/.exec(setCookie)![1];
            const home = await app.request('/', {
                headers: { cookie: `session=${sessionValue}` },
            });
            assertEquals(home.status, 200);
            assert((await home.text()).includes('minidumpster'));

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
            await Deno.mkdir(`${env.dir}/symbols/bundles`, { recursive: true });
            await Deno.writeTextFile(
                `${env.dir}/symbols/bundles/helium-0.14.5.1`,
                '',
            );
            const symbols = await app.request('/symbols', {
                headers: { cookie: `session=${sessionValue}` },
            });
            assertEquals(symbols.status, 200);
            const symbolsHtml = await symbols.text();
            assert(symbolsHtml.includes('build-artifact-arm64'));
            assert(symbolsHtml.includes('symbols installed'));

            // A tampered signature is rejected.
            const tampered = await app.request('/', {
                headers: { cookie: `session=${sessionValue}x` },
            });
            assertEquals(tampered.status, 302);
            assertEquals(tampered.headers.get('location'), '/auth/login');
        });
    } finally {
        await env.cleanup();
    }
});

Deno.test('OAuth callback rejects non-members with 403', async () => {
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
            assertEquals(res.status, 403);
            assert((await res.text()).includes('not an active member'));
        });
    } finally {
        await env.cleanup();
    }
});

Deno.test('OAuth callback rejects state mismatches', async () => {
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
            assertEquals(res.status, 401);
            await res.body?.cancel();
        });
    } finally {
        await env.cleanup();
    }
});

Deno.test('UI routes redirect to login without a session', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        for (
            const path of [
                '/',
                '/symbols',
                '/groups/1',
                '/reports/x',
                '/reports/x/dump',
            ]
        ) {
            const res = await app.request(path);
            assertEquals(res.status, 302, `expected redirect for ${path}`);
            assertEquals(res.headers.get('location'), '/auth/login');
        }
    } finally {
        await env.cleanup();
    }
});

Deno.test('the stylesheet is served without a session', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });

        const res = await app.request('/style.css');
        assertEquals(res.status, 200);
        assertEquals(
            res.headers.get('content-type'),
            'text/css; charset=utf-8',
        );
        assert((await res.text()).includes('.expandable'));

        // Everything else stays gated.
        const page = await app.request('/');
        assertEquals(page.status, 302);
        assertEquals(page.headers.get('location'), '/auth/login');
    } finally {
        await env.cleanup();
    }
});
