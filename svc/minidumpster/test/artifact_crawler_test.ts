import { assert, assertEquals } from '@std/assert';

import { _test, crawlArtifactsOnce } from '../src/artifact-crawler.ts';
import { makeTestEnv } from './helpers.ts';

function json(data: unknown, status = 200): Response {
    return Response.json(data, { status });
}

Deno.test('crawler classifies platform build artifacts and symbol archives', () => {
    const symbols = /symbols/i;
    assertEquals(
        _test.artifactKind(
            'imputnet/helium-macos',
            'github_build_artifact_arm64',
            symbols,
        ),
        'mac-build',
    );
    assertEquals(
        _test.artifactKind(
            'imputnet/helium-windows',
            'build-artifact-x86_64',
            symbols,
        ),
        'windows-build',
    );
    assertEquals(
        _test.artifactKind(
            'imputnet/helium-linux',
            'helium-1.2.3-x86_64-symbols',
            symbols,
        ),
        'symbols',
    );
    assertEquals(
        _test.artifactKind(
            'imputnet/helium-windows',
            'helium-x86_64',
            symbols,
        ),
        null,
    );
});

Deno.test('crawler stops the pass when GitHub is rate limited', async () => {
    const env = await makeTestEnv({
        githubArtifactToken: 'github-artifact-token',
    });
    try {
        let requests = 0;
        await crawlArtifactsOnce({
            db: env.db,
            config: env.config,
            githubApiUrl: 'https://api.test',
            fetchFn: () => {
                requests++;
                return Promise.resolve(
                    new Response('{"message":"API rate limit exceeded"}', {
                        status: 403,
                        headers: { 'x-ratelimit-remaining': '0' },
                    }),
                );
            },
        });
        assertEquals(requests, 1);
    } finally {
        await env.cleanup();
    }
});

Deno.test('crawler ingests symbol artifacts from release-producing runs once', async () => {
    const env = await makeTestEnv({
        githubArtifactToken: 'github-artifact-token',
    });
    try {
        let uploads = 0;
        const fetchMock: typeof fetch = (input, init) => {
            const url = new URL(
                typeof input === 'string' || input instanceof URL
                    ? input
                    : input.url,
            );
            if (url.origin === 'https://api.test') {
                assertEquals(
                    new Headers(init?.headers).get('authorization'),
                    'Bearer github-artifact-token',
                );
                if (url.pathname.endsWith('/releases')) {
                    return Promise.resolve(
                        json([{ tag_name: '1.2.3.4', draft: false }]),
                    );
                }
                if (url.pathname.includes('/commits/')) {
                    return Promise.resolve(json({ sha: 'release-sha' }));
                }
                if (url.pathname.endsWith('/actions/artifacts')) {
                    const isLinux = url.pathname.includes('/helium-linux/');
                    return Promise.resolve(json({
                        total_count: isLinux ? 4 : 0,
                        artifacts: isLinux
                            ? [
                                {
                                    id: 42,
                                    name: 'helium-1.2.3.4-x86_64-symbols',
                                    size_in_bytes: 1234,
                                    created_at: new Date(1_000_000)
                                        .toISOString(),
                                    expired: false,
                                    workflow_run: {
                                        id: 99,
                                        head_sha: 'release-sha',
                                    },
                                },
                                {
                                    id: 43,
                                    name: 'helium-1.2.3.4-x86_64-AppImage',
                                    size_in_bytes: 1234,
                                    created_at: new Date(1_000_000)
                                        .toISOString(),
                                    expired: false,
                                    workflow_run: {
                                        id: 99,
                                        head_sha: 'release-sha',
                                    },
                                },
                                {
                                    id: 44,
                                    name: 'other-release-symbols',
                                    size_in_bytes: 1234,
                                    created_at: new Date(1_000_000)
                                        .toISOString(),
                                    expired: false,
                                    workflow_run: {
                                        id: 100,
                                        head_sha: 'other-sha',
                                    },
                                },
                                {
                                    id: 45,
                                    name: 'helium-old-symbols',
                                    size_in_bytes: 1234,
                                    created_at: new Date(
                                        1_000_000 - 8 * 24 * 60 * 60 * 1000,
                                    ).toISOString(),
                                    expired: false,
                                    workflow_run: {
                                        id: 99,
                                        head_sha: 'release-sha',
                                    },
                                },
                            ]
                            : [],
                    }));
                }
                if (url.pathname.endsWith('/actions/runs/99/jobs')) {
                    return Promise.resolve(json({
                        jobs: [{
                            name: 'Create release',
                            conclusion: 'success',
                        }],
                    }));
                }
                if (url.pathname.endsWith('/actions/artifacts/42/zip')) {
                    return Promise.resolve(
                        new Response(new Uint8Array([80, 75, 3, 4]), {
                            headers: { 'content-length': '4' },
                        }),
                    );
                }
            }
            throw new Error(`unexpected request: ${url}`);
        };

        const deps = {
            db: env.db,
            config: env.config,
            fetchFn: fetchMock,
            githubApiUrl: 'https://api.test',
            now: () => 1_000_000,
            ingestFn: async (
                body: ReadableStream<Uint8Array>,
                product: string,
                version: string,
                kind: string,
            ) => {
                uploads++;
                assertEquals(product, 'helium');
                assertEquals(version, '1.2.3.4');
                assertEquals(kind, 'symbols');
                assertEquals(
                    [...new Uint8Array(await new Response(body).arrayBuffer())],
                    [80, 75, 3, 4],
                );
                return {
                    ok: true as const,
                    product: 'helium',
                    version: '1.2.3.4',
                    filesExtracted: 1,
                    debugIds: ['a'.repeat(40)],
                    output: '',
                    requeued: 2,
                };
            },
        };
        await crawlArtifactsOnce(deps);
        await crawlArtifactsOnce(deps);

        assertEquals(uploads, 1);
        const row = env.db.getArtifactIngest('imputnet/helium-linux', 42);
        assert(row);
        assertEquals(row.status, 'ingested');
        assertEquals(row.release_tag, '1.2.3.4');
        assertEquals(row.attempts, 1);
        assertEquals(
            env.db.getArtifactIngest('imputnet/helium-linux', 45),
            null,
        );
    } finally {
        await env.cleanup();
    }
});

Deno.test('crawler ignores artifacts from runs without a successful release job', async () => {
    const env = await makeTestEnv({
        githubArtifactToken: 'github-artifact-token',
    });
    try {
        const fetchMock: typeof fetch = (input) => {
            const url = new URL(
                typeof input === 'string' || input instanceof URL
                    ? input
                    : input.url,
            );
            if (url.pathname.endsWith('/releases')) {
                return Promise.resolve(
                    json([{ tag_name: '1.0', draft: false }]),
                );
            }
            if (url.pathname.includes('/commits/')) {
                return Promise.resolve(json({ sha: 'sha' }));
            }
            if (url.pathname.endsWith('/actions/artifacts')) {
                const isLinux = url.pathname.includes('/helium-linux/');
                return Promise.resolve(json({
                    total_count: isLinux ? 1 : 0,
                    artifacts: isLinux
                        ? [{
                            id: 7,
                            name: 'helium-symbols',
                            size_in_bytes: 100,
                            created_at: new Date().toISOString(),
                            expired: false,
                            workflow_run: { id: 8, head_sha: 'sha' },
                        }]
                        : [],
                }));
            }
            if (url.pathname.endsWith('/actions/runs/8/jobs')) {
                return Promise.resolve(json({
                    jobs: [{ name: 'Create release', conclusion: 'skipped' }],
                }));
            }
            throw new Error(`unexpected request: ${url}`);
        };

        await crawlArtifactsOnce({
            db: env.db,
            config: env.config,
            fetchFn: fetchMock,
            githubApiUrl: 'https://api.test',
        });
        assertEquals(
            env.db.getArtifactIngest('imputnet/helium-linux', 7),
            null,
        );
    } finally {
        await env.cleanup();
    }
});
