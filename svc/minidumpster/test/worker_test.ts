import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, stat, utimes } from 'node:fs/promises';

import { processReport, startWorker } from '../src/worker.ts';
import { runRetention, runSymbolRetention } from '../src/retention.ts';
import {
    fixtureResponse,
    makeTestEnv,
    minimalMinidump,
    type TestEnv,
} from './helpers.ts';
import { dumpPath, processedPath, writeFileWithDirs } from '../src/paths.ts';

async function insertPendingReport(
    env: TestEnv,
    id: string,
    receivedAt: number = Date.now(),
): Promise<void> {
    await writeFileWithDirs(dumpPath(env.dir, id), minimalMinidump());
    env.db.insertReport({
        id,
        product: 'MyBrowser',
        version: '138.0.1.0',
        guid: null,
        ptype: 'renderer',
        channel: 'stable',
        annotations: '{}',
        received_at: receivedAt,
    });
}

async function assertFilesDoNotExist(...paths: string[]): Promise<void> {
    for (const path of paths) {
        await assert.rejects(stat(path), { code: 'ENOENT' });
    }
}

async function assertPayloadDiscarded(env: TestEnv, id: string): Promise<void> {
    assert.equal(env.db.getReport(id), null);
    await assertFilesDoNotExist(
        dumpPath(env.dir, id),
        processedPath(env.dir, id),
    );
}

/** Mock Symbolicator implementing the pending/poll protocol. */
function mockSymbolicator(fixture: string, pendingPolls: number) {
    let polls = 0;
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (init?.method === 'POST' && url.pathname === '/minidump') {
            return Promise.resolve(
                Response.json({
                    status: 'pending',
                    request_id: 'req-1',
                    retry_after: 0,
                }),
            );
        }
        if (url.pathname === '/requests/req-1') {
            polls++;
            if (polls <= pendingPolls) {
                return Promise.resolve(
                    Response.json({
                        status: 'pending',
                        request_id: 'req-1',
                        retry_after: 0,
                    }),
                );
            }
            return Promise.resolve(
                new Response(fixture, {
                    headers: { 'content-type': 'application/json' },
                }),
            );
        }
        return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    return {
        fetchFn,
        polls: () => polls,
    };
}

test('worker follows the pending/poll protocol and groups the report', async () => {
    const fixture = await fixtureResponse();
    const mock = mockSymbolicator(fixture, 2);
    const env = await makeTestEnv();
    try {
        await insertPendingReport(env, crypto.randomUUID());
        const claimed = env.db.claimNext(Date.now());
        assert(claimed);
        assert.equal(env.db.getReport(claimed.id)!.status, 'processing');

        await processReport(
            {
                db: env.db,
                config: env.config,
                fetchFn: mock.fetchFn,
                pollIntervalMs: 5,
            },
            claimed,
        );

        assert(
            mock.polls() >= 3,
            'should have polled through the pending responses',
        );
        const row = env.db.getReport(claimed.id)!;
        assert.equal(row.status, 'processed');
        assert.equal(row.attempts, 1);
        assert.equal(row.next_attempt_at, 0);
        assert.equal(row.platform, 'Windows');
        assert(row.group_id != null);

        const group = env.db.getGroup(row.group_id!)!;
        assert.deepStrictEqual(
            group.title,
            'content::RenderProcessHostImpl::OnChannelError()',
        );
        assert.equal(group.report_count, 1);

        const processed = JSON.parse(
            await readFile(processedPath(env.dir, claimed.id), 'utf8'),
        );
        assert.equal(processed.status, 'completed');
        assert.deepStrictEqual(
            env.db.searchReports('RenderProcessHostImpl').map((r) => r.id),
            [claimed.id],
        );
    } finally {
        await env.cleanup();
    }
});

test('worker shutdown wakes idle polling and aborts symbolication', async () => {
    const env = await makeTestEnv({ workerPollMs: 60_000 });
    try {
        const idle = startWorker({ db: env.db, config: env.config });
        const idleStarted = performance.now();
        await idle.stop();
        assert(performance.now() - idleStarted < 1000);

        const id = crypto.randomUUID();
        await insertPendingReport(env, id);
        const { promise: started, resolve: notifyStarted } =
            Promise.withResolvers<void>();
        let requests = 0;
        const fetchFn = ((
            _input: string | URL | Request,
            init?: RequestInit,
        ) => {
            requests++;
            notifyStarted();
            return new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                }
                signal?.addEventListener('abort', () => reject(signal.reason), {
                    once: true,
                });
            });
        }) as typeof fetch;
        const abort = new AbortController();
        const active = startWorker({
            db: env.db,
            config: env.config,
            fetchFn,
            signal: abort.signal,
        });
        await started;
        const activeStarted = performance.now();
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(requests, 1);
        await active.stop();
        assert(performance.now() - activeStarted < 1000);
        const row = env.db.getReport(id)!;
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 0);
        assert.equal(row.next_attempt_at, 0);
    } finally {
        await env.cleanup();
    }
});

test('worker survives a secondary report-state write failure', async () => {
    const completed = await fixtureResponse();
    let requests = 0;
    const fetchFn = (() =>
        Promise.resolve(
            requests++ === 0
                ? new Response('temporary failure', { status: 500 })
                : new Response(completed, {
                      headers: { 'content-type': 'application/json' },
                  }),
        )) as typeof fetch;
    const env = await makeTestEnv({ workerPollMs: 5 });
    try {
        const id = crypto.randomUUID();
        await insertPendingReport(env, id);
        const markRetry = env.db.markRetry.bind(env.db);
        let failOnce = true;
        env.db.markRetry = (...args) => {
            if (failOnce) {
                failOnce = false;
                throw new Error('simulated state write failure');
            }
            markRetry(...args);
        };

        const worker = startWorker({ db: env.db, config: env.config, fetchFn });
        const deadline = Date.now() + 1000;
        while (
            env.db.getReport(id)?.status !== 'processed'
            && Date.now() < deadline
        ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await worker.stop();
        assert.equal(env.db.getReport(id)?.status, 'processed');
        assert.equal(requests, 2);
    } finally {
        await env.cleanup();
    }
});

test('two crashes with the same stack land in the same group', async () => {
    const fixture = await fixtureResponse();
    const mock = mockSymbolicator(fixture, 0);
    const env = await makeTestEnv();
    try {
        await insertPendingReport(env, crypto.randomUUID());
        await insertPendingReport(env, crypto.randomUUID());
        const claimed = [
            env.db.claimNext(Date.now())!,
            env.db.claimNext(Date.now())!,
        ];
        for (const r of claimed) {
            await processReport(
                {
                    db: env.db,
                    config: env.config,
                    fetchFn: mock.fetchFn,
                    pollIntervalMs: 5,
                },
                r,
            );
        }
        const a = env.db.getReport(claimed[0].id)!;
        const b = env.db.getReport(claimed[1].id)!;
        assert.deepStrictEqual(a.group_id, b.group_id);
        assert.equal(env.db.getGroup(a.group_id!)!.report_count, 2);
    } finally {
        await env.cleanup();
    }
});

test('worker retries with backoff, then discards terminal failures', async () => {
    const fetchFn = (() =>
        Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch;
    const env = await makeTestEnv({
        maxAttempts: 2,
    });
    try {
        const id = crypto.randomUUID();
        await insertPendingReport(env, id);
        const group = env.db.upsertGroup(
            'terminal-failure',
            'terminal',
            Date.now(),
        );
        env.db.markProcessed(id, group, 'Windows', Date.now(), false, 1);
        env.db.recountGroups([group]);
        assert.deepStrictEqual(
            env.db.requeueUnsymbolicated('MyBrowser', '138.0.1.0', 0),
            1,
        );
        const first = env.db.claimNext(Date.now())!;
        await processReport(
            {
                db: env.db,
                config: env.config,
                fetchFn,
                pollIntervalMs: 5,
            },
            first,
        );

        const row = env.db.getReport(first.id)!;
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 1);
        assert(row.error && row.error.includes('500'));
        assert(
            row.next_attempt_at > Date.now(),
            'retry should be scheduled in the future',
        );
        assert.deepStrictEqual(
            env.db.claimNext(Date.now()),
            null,
            'not claimable before backoff elapses',
        );

        const second = env.db.claimNext(row.next_attempt_at + 1);
        assert(second);
        await writeFileWithDirs(
            processedPath(env.dir, first.id),
            '{"sensitive":"partial result"}',
        );
        await processReport(
            {
                db: env.db,
                config: env.config,
                fetchFn,
                pollIntervalMs: 5,
            },
            second,
        );
        await assertPayloadDiscarded(env, first.id);
        assert.equal(env.db.getGroup(group), null);
        assert.deepStrictEqual(env.db.reportsPerDay(0), []);
    } finally {
        await env.cleanup();
    }
});

test('worker drops raw data rejected by Symbolicator parsing', async () => {
    let requests = 0;
    const fetchFn = (() => {
        requests++;
        return Promise.resolve(
            Response.json({
                status: 'failed',
                message: 'malformed minidump with sensitive details',
            }),
        );
    }) as typeof fetch;
    const env = await makeTestEnv({
        maxAttempts: 5,
    });
    try {
        const id = crypto.randomUUID();
        await writeFileWithDirs(dumpPath(env.dir, id), new Uint8Array([1]));
        await writeFileWithDirs(
            processedPath(env.dir, id),
            '{"sensitive":"old processing result"}',
        );
        env.db.insertReport({
            id,
            product: 'MyBrowser',
            version: '1.0',
            guid: 'sensitive-guid',
            ptype: 'renderer',
            channel: 'stable',
            annotations: JSON.stringify({ uploaded_by: 'jj', secret: 'x' }),
            received_at: Date.now(),
        });
        const group = env.db.upsertGroup('rejected', 'rejected', Date.now());
        env.db.markProcessed(id, group, 'Windows', Date.now(), false, 1);
        env.db.recountGroups([group]);
        assert.deepStrictEqual(
            env.db.requeueUnsymbolicated('MyBrowser', '1.0', 0),
            1,
        );
        const claimed = env.db.claimNext(Date.now())!;
        await processReport(
            {
                db: env.db,
                config: env.config,
                fetchFn,
                pollIntervalMs: 5,
            },
            claimed,
        );

        await assertPayloadDiscarded(env, id);
        assert.equal(env.db.getGroup(group), null);
        assert.deepStrictEqual(env.db.reportsPerDay(0), []);
        assert.equal(requests, 1);
        assert.equal(env.db.claimNext(Number.MAX_SAFE_INTEGER), null);
    } finally {
        await env.cleanup();
    }
});

test('worker drops non-actionable crashes after symbolication', async () => {
    const response = JSON.parse(await fixtureResponse());
    response.stacktraces[0].frames[1].function =
        'partition_alloc::TerminateBecauseOutOfMemory(unsigned long long)';
    const mock = mockSymbolicator(JSON.stringify(response), 0);
    const env = await makeTestEnv();
    try {
        const id = crypto.randomUUID();
        await insertPendingReport(env, id);
        const claimed = env.db.claimNext(Date.now());
        assert(claimed);

        await processReport(
            {
                db: env.db,
                config: env.config,
                fetchFn: mock.fetchFn,
                pollIntervalMs: 5,
            },
            claimed,
        );

        await assertPayloadDiscarded(env, id);
        assert.deepStrictEqual(env.db.reportsPerDay(0), []);
    } finally {
        await env.cleanup();
    }
});

test('retention deletes expired reports and all of their files', async () => {
    const env = await makeTestEnv({ retentionDays: 30 });
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60 * 1000;
    try {
        const oldId = crypto.randomUUID();
        const newId = crypto.randomUUID();
        await writeFileWithDirs(dumpPath(env.dir, oldId), 'sensitive dump');
        await writeFileWithDirs(processedPath(env.dir, oldId), '{}');
        env.db.insertReport({
            id: oldId,
            product: 'MyBrowser',
            version: '1.0',
            guid: 'sensitive-guid',
            ptype: 'renderer',
            channel: 'stable',
            annotations: JSON.stringify({
                uploaded_by: 'jj',
                secret: 'annotation',
            }),
            received_at: old,
        });
        await insertPendingReport(env, newId);
        const group = env.db.upsertGroup('retention-test', 'retention', old);
        env.db.markProcessed(oldId, group, 'Windows', old, true, 1);

        assert.equal(runRetention(env.db, env.config, now), 1);
        assert.equal(env.db.getReport(oldId), null);
        assert.equal(env.db.getGroup(group), null);
        assert(env.db.getReport(newId));
        await stat(dumpPath(env.dir, newId));
        await assertFilesDoNotExist(
            dumpPath(env.dir, oldId),
            processedPath(env.dir, oldId),
        );
    } finally {
        await env.cleanup();
    }
});

test('retention skips active workers and deletes rows before files', async () => {
    const env = await makeTestEnv({ retentionDays: 30 });
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60 * 1000;
    try {
        const id = crypto.randomUUID();
        await insertPendingReport(env, id, old);
        const claimed = env.db.claimNext(now)!;
        assert.deepStrictEqual(claimed.id, id);
        assert.equal(env.db.getReport(id)?.status, 'processing');

        assert.equal(runRetention(env.db, env.config, now), 0);
        assert.equal(env.db.getReport(id)?.status, 'processing');
        await stat(dumpPath(env.dir, id));

        env.db.markRetry(id, 'requeued after processing', 1, 0);
        assert.equal(runRetention(env.db, env.config, now), 1);
        assert.equal(env.db.getReport(id), null);
        await assertFilesDoNotExist(dumpPath(env.dir, id));
    } finally {
        await env.cleanup();
    }
});

test('symbols upload requeues unsymbolicated reports, which then regroup', async () => {
    const unsymbolicated = JSON.stringify({
        status: 'completed',
        system_info: { os_name: 'macOS 26.5.1', cpu_arch: 'arm64' },
        crash_reason: 'EXC_BREAKPOINT (SIGTRAP)',
        modules: [
            {
                code_file: '/app/Helium',
                image_addr: '0x100000000',
                image_size: 1048576,
            },
        ],
        stacktraces: [
            {
                thread_id: 0,
                is_requesting: true,
                frames: [
                    {
                        status: 'missing',
                        package: '/app/Helium',
                        instruction_addr: '0x100001234',
                    },
                ],
            },
        ],
    });
    const symbolicated = JSON.stringify({
        status: 'completed',
        system_info: { os_name: 'macOS 26.5.1', cpu_arch: 'arm64' },
        crash_reason: 'EXC_BREAKPOINT (SIGTRAP)',
        stacktraces: [
            {
                thread_id: 0,
                is_requesting: true,
                frames: [
                    {
                        status: 'symbolicated',
                        package: '/app/Helium',
                        function: 'HeliumThing::Explode()',
                        instruction_addr: '0x100001234',
                    },
                ],
            },
        ],
    });
    let withSymbols = false;
    const fetchFn = (() =>
        Promise.resolve(
            new Response(withSymbols ? symbolicated : unsymbolicated, {
                headers: { 'content-type': 'application/json' },
            }),
        )) as typeof fetch;
    const env = await makeTestEnv();
    try {
        const id = crypto.randomUUID();
        await writeFileWithDirs(dumpPath(env.dir, id), new Uint8Array([1]));
        env.db.insertReport({
            id,
            product: 'Helium',
            version: '0.14.3.1',
            guid: null,
            ptype: null,
            channel: null,
            annotations: '{}',
            received_at: Date.now(),
        });
        const first = env.db.claimNext(Date.now())!;
        await processReport(
            {
                db: env.db,
                config: env.config,
                fetchFn,
                pollIntervalMs: 5,
            },
            first,
        );
        let row = env.db.getReport(id)!;
        assert.equal(row.status, 'processed');
        assert.equal(row.symbolicated, 0);
        await stat(dumpPath(env.dir, id));
        const junkGroupId = row.group_id!;

        // Symbols arrive (product name cased differently, as CI would send).
        const notBefore = Date.now() + 50;
        assert.deepStrictEqual(
            env.db.requeueUnsymbolicated('helium', '0.14.3.1', notBefore),
            1,
        );
        assert.equal(env.db.getReport(id)!.status, 'pending');
        assert.equal(env.db.getReport(id)!.group_id, null);
        assert.equal(env.db.getGroup(junkGroupId), null);
        assert.deepStrictEqual(
            env.db.claimNext(Date.now()),
            null,
            'not claimable before the negative-cache delay',
        );

        withSymbols = true;
        const second = env.db.claimNext(notBefore + 1);
        assert(second);
        await processReport(
            {
                db: env.db,
                config: env.config,
                fetchFn,
                pollIntervalMs: 5,
            },
            second,
        );
        row = env.db.getReport(id)!;
        assert.equal(row.status, 'processed');
        assert.equal(row.symbolicated, 1);
        assert(row.group_id !== junkGroupId, 'report moved to a new group');
        assert.deepStrictEqual(
            env.db.getGroup(row.group_id!)!.title,
            'HeliumThing::Explode()',
        );
        assert.equal(env.db.getGroup(row.group_id!)!.report_count, 1);
        assert.deepStrictEqual(
            env.db.getGroup(junkGroupId),
            null,
            'drained group is pruned',
        );
        // Nothing left to requeue.
        assert.deepStrictEqual(
            env.db.requeueUnsymbolicated('helium', '0.14.3.1', notBefore),
            0,
        );
    } finally {
        await env.cleanup();
    }
});

test('symbol retention expires old bundles but keeps shared debug files', async () => {
    const env = await makeTestEnv({ symbolsRetentionDays: 180 });
    try {
        const symRoot = `${env.dir}/symbols`;
        const mk = async (path: string, content = 'x') => {
            await writeFileWithDirs(`${symRoot}/${path}`, content);
        };
        // Bundle meta files: helium-1.0.0 is ancient, helium-2.0.0 is fresh.
        await mk('bundles/helium-1.0.0');
        await mk('bundles/helium-2.0.0');
        const past = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
        await utimes(`${symRoot}/bundles/helium-1.0.0`, past, past);

        // Debug file only in the old build -> should be deleted entirely.
        await mk('aa/aa1111/debuginfo');
        await mk('aa/aa1111/refs/helium-1.0.0');
        // Debug file shared by both builds -> keeps its dir, loses the old ref.
        await mk('bb/bb2222/debuginfo');
        await mk('bb/bb2222/refs/helium-1.0.0');
        await mk('bb/bb2222/refs/helium-2.0.0');

        const result = await runSymbolRetention(env.config);
        assert.equal(result.bundles, 1);
        assert.equal(result.debugDirs, 1);

        let oldGone = false;
        try {
            await stat(`${symRoot}/aa`);
        } catch {
            oldGone = true;
        }
        assert(oldGone, 'old-only debug dir and its shard should be removed');
        await stat(`${symRoot}/bb/bb2222/debuginfo`); // still there
        await stat(`${symRoot}/bb/bb2222/refs/helium-2.0.0`);
        let refGone = false;
        try {
            await stat(`${symRoot}/bb/bb2222/refs/helium-1.0.0`);
        } catch {
            refGone = true;
        }
        assert(
            refGone,
            'expired ref on the shared debug file should be removed',
        );
        let bundleGone = false;
        try {
            await stat(`${symRoot}/bundles/helium-1.0.0`);
        } catch {
            bundleGone = true;
        }
        assert(bundleGone, 'expired bundle meta should be removed');
        await stat(`${symRoot}/bundles/helium-2.0.0`);

        // Second run is a no-op.
        assert.equal((await runSymbolRetention(env.config)).bundles, 0);

        // Disabled retention never deletes.
        const off = await runSymbolRetention({
            ...env.config,
            symbolsRetentionDays: 0,
        });
        assert.equal(off.bundles, 0);
    } finally {
        await env.cleanup();
    }
});
