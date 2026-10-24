import assert from 'node:assert/strict';
import { test } from 'node:test';

import { _test, crawlArtifactsOnce } from '../src/artifact-crawler.ts';
import { makeTestEnv } from './helpers.ts';

function json(data: unknown, status = 200): Response {
    return Response.json(data, { status });
}

function singleArtifactFetch(
    size: number,
    jobConclusion: string,
): typeof fetch {
    return (input) => {
        const url = new URL(
            typeof input === 'string' || input instanceof URL
                ? input
                : input.url,
        );
        if (url.pathname.endsWith('/releases')) {
            return Promise.resolve(json([{ tag_name: '1.0', draft: false }]));
        }
        if (url.pathname.includes('/commits/')) {
            return Promise.resolve(json({ sha: 'sha' }));
        }
        if (url.pathname.endsWith('/actions/artifacts')) {
            const artifacts = url.pathname.includes('/helium-linux/')
                ? [
                      {
                          id: 7,
                          name: 'helium-symbols',
                          size_in_bytes: size,
                          created_at: new Date().toISOString(),
                          expired: false,
                          workflow_run: { id: 8, head_sha: 'sha' },
                      },
                  ]
                : [];
            return Promise.resolve(
                json({
                    total_count: artifacts.length,
                    artifacts,
                }),
            );
        }
        if (url.pathname.endsWith('/actions/runs/8/jobs')) {
            return Promise.resolve(
                json({
                    jobs: [
                        {
                            name: 'Create release',
                            conclusion: jobConclusion,
                        },
                    ],
                }),
            );
        }
        throw new Error(`unexpected request: ${url}`);
    };
}

test('crawler classifies platform build artifacts and symbol archives', () => {
    const symbols = /symbols/i;
    assert.deepStrictEqual(
        _test.artifactKind(
            'imputnet/helium-macos',
            'github_build_artifact_arm64',
            symbols,
        ),
        'mac-build',
    );
    assert.deepStrictEqual(
        _test.artifactKind(
            'imputnet/helium-windows',
            'build-artifact-x86_64',
            symbols,
        ),
        'windows-build',
    );
    assert.deepStrictEqual(
        _test.artifactKind(
            'imputnet/helium-linux',
            'helium-1.2.3-x86_64-symbols',
            symbols,
        ),
        'symbols',
    );
    assert.deepStrictEqual(
        _test.artifactKind('imputnet/helium-windows', 'helium-x86_64', symbols),
        null,
    );
});

test('crawler stops the pass when GitHub is rate limited', async () => {
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
        assert.equal(requests, 1);
    } finally {
        await env.cleanup();
    }
});

test('crawler resumes a rate-limited symbol artifact download', async () => {
    const env = await makeTestEnv({
        githubArtifactToken: 'github-artifact-token',
    });
    try {
        let uploads = 0;
        let downloadRateLimited = true;
        let now = 1_000_000;
        const fetchMock: typeof fetch = (input, init) => {
            const url = new URL(
                typeof input === 'string' || input instanceof URL
                    ? input
                    : input.url,
            );
            if (url.origin === 'https://api.test') {
                assert.deepStrictEqual(
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
                    return Promise.resolve(
                        json({
                            total_count: isLinux ? 4 : 0,
                            artifacts: isLinux
                                ? [
                                      {
                                          id: 42,
                                          name: 'helium-1.2.3.4-x86_64-symbols',
                                          size_in_bytes: 1234,
                                          created_at: new Date(
                                              1_000_000,
                                          ).toISOString(),
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
                                          created_at: new Date(
                                              1_000_000,
                                          ).toISOString(),
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
                                          created_at: new Date(
                                              1_000_000,
                                          ).toISOString(),
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
                                              1_000_000
                                                  - 8 * 24 * 60 * 60 * 1000,
                                          ).toISOString(),
                                          expired: false,
                                          workflow_run: {
                                              id: 99,
                                              head_sha: 'release-sha',
                                          },
                                      },
                                  ]
                                : [],
                        }),
                    );
                }
                if (url.pathname.endsWith('/actions/runs/99/jobs')) {
                    return Promise.resolve(
                        json({
                            jobs: [
                                {
                                    name: 'Create release',
                                    conclusion: 'success',
                                },
                            ],
                        }),
                    );
                }
                if (url.pathname.endsWith('/actions/artifacts/42/zip')) {
                    if (downloadRateLimited) {
                        downloadRateLimited = false;
                        return Promise.resolve(
                            new Response('rate limited', {
                                status: 403,
                                headers: { 'x-ratelimit-remaining': '0' },
                            }),
                        );
                    }
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
            now: () => now,
            ingestFn: async (
                body: ReadableStream<Uint8Array>,
                product: string,
                version: string,
                kind: string,
            ) => {
                uploads++;
                assert.equal(product, 'helium');
                assert.equal(version, '1.2.3.4');
                assert.equal(kind, 'symbols');
                assert.deepStrictEqual(
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
        now += env.config.artifactCrawlerPollMs;
        await crawlArtifactsOnce(deps);

        assert.equal(uploads, 1);
        const row = env.db.getArtifactIngest('imputnet/helium-linux', 42);
        assert(row);
        assert.equal(row.status, 'ingested');
        assert.equal(row.release_tag, '1.2.3.4');
        assert.equal(row.attempts, 1);
        assert.deepStrictEqual(
            env.db.getArtifactIngest('imputnet/helium-linux', 45),
            null,
        );
    } finally {
        await env.cleanup();
    }
});

test('crawler ignores artifacts from runs without a successful release job', async () => {
    const env = await makeTestEnv({
        githubArtifactToken: 'github-artifact-token',
    });
    try {
        await crawlArtifactsOnce({
            db: env.db,
            config: env.config,
            fetchFn: singleArtifactFetch(100, 'skipped'),
            githubApiUrl: 'https://api.test',
        });
        assert.deepStrictEqual(
            env.db.getArtifactIngest('imputnet/helium-linux', 7),
            null,
        );
    } finally {
        await env.cleanup();
    }
});

test('crawler ignores artifacts larger than its configured download size', async () => {
    const env = await makeTestEnv({
        githubArtifactToken: 'github-artifact-token',
        artifactCrawlerMaxBytes: 100,
    });
    try {
        const deps = {
            db: env.db,
            config: env.config,
            fetchFn: singleArtifactFetch(101, 'success'),
            githubApiUrl: 'https://api.test',
            ingestFn: () => Promise.reject(new Error('should not ingest')),
        };

        await crawlArtifactsOnce(deps);
        await crawlArtifactsOnce(deps);
        assert.deepStrictEqual(
            env.db.getArtifactIngest('imputnet/helium-linux', 7),
            null,
        );
    } finally {
        await env.cleanup();
    }
});
