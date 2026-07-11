import { assert, assertEquals } from '@std/assert';

import { processReport } from '../src/worker.ts';
import { runRetention, runSymbolRetention } from '../src/retention.ts';
import { fixtureResponse, makeTestEnv, type TestEnv } from './helpers.ts';
import { dumpPath, processedPath, writeFileWithDirs } from '../src/paths.ts';

async function insertPendingReport(
    env: TestEnv,
    id: string,
    receivedAt: number = Date.now(),
): Promise<void> {
    await writeFileWithDirs(
        dumpPath(env.dir, id),
        new Uint8Array([0x4d, 0x44, 0x4d, 0x50, 1, 2, 3]),
    );
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

/** Mock Symbolicator implementing the pending/poll protocol. */
function mockSymbolicator(fixture: string, pendingPolls: number) {
    let polls = 0;
    const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/minidump') {
            return Response.json({
                status: 'pending',
                request_id: 'req-1',
                retry_after: 0,
            });
        }
        if (req.method === 'GET' && url.pathname === '/requests/req-1') {
            polls++;
            if (polls <= pendingPolls) {
                return Response.json({
                    status: 'pending',
                    request_id: 'req-1',
                    retry_after: 0,
                });
            }
            return new Response(fixture, {
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response('not found', { status: 404 });
    });
    const addr = server.addr;
    return {
        url: `http://127.0.0.1:${addr.port}`,
        polls: () => polls,
        shutdown: () => server.shutdown(),
    };
}

Deno.test('worker follows the pending/poll protocol and groups the report', async () => {
    const fixture = await fixtureResponse();
    const mock = mockSymbolicator(fixture, 2);
    const env = await makeTestEnv({ symbolicatorUrl: mock.url });
    try {
        await insertPendingReport(env, crypto.randomUUID());
        const [claimed] = env.db.claimPending(1, Date.now());
        assert(claimed);
        assertEquals(env.db.getReport(claimed.id)!.status, 'processing');

        await processReport({
            db: env.db,
            config: env.config,
            pollIntervalMs: 5,
        }, claimed);

        assert(
            mock.polls() >= 3,
            'should have polled through the pending responses',
        );
        const row = env.db.getReport(claimed.id)!;
        assertEquals(row.status, 'processed');
        assertEquals(row.platform, 'Windows');
        assert(row.group_id != null);

        const group = env.db.getGroup(row.group_id!)!;
        assertEquals(
            group.title,
            'content::RenderProcessHostImpl::OnChannelError()',
        );
        assertEquals(group.report_count, 1);

        const processed = JSON.parse(
            await Deno.readTextFile(processedPath(env.dir, claimed.id)),
        );
        assertEquals(processed.status, 'completed');
    } finally {
        await mock.shutdown();
        await env.cleanup();
    }
});

Deno.test('two crashes with the same stack land in the same group', async () => {
    const fixture = await fixtureResponse();
    const mock = mockSymbolicator(fixture, 0);
    const env = await makeTestEnv({ symbolicatorUrl: mock.url });
    try {
        await insertPendingReport(env, crypto.randomUUID());
        await insertPendingReport(env, crypto.randomUUID());
        const claimed = env.db.claimPending(10, Date.now());
        assertEquals(claimed.length, 2);
        for (const r of claimed) {
            await processReport({
                db: env.db,
                config: env.config,
                pollIntervalMs: 5,
            }, r);
        }
        const a = env.db.getReport(claimed[0].id)!;
        const b = env.db.getReport(claimed[1].id)!;
        assertEquals(a.group_id, b.group_id);
        assertEquals(env.db.getGroup(a.group_id!)!.report_count, 2);
    } finally {
        await mock.shutdown();
        await env.cleanup();
    }
});

Deno.test('worker retries with backoff, then marks the report failed', async () => {
    const server = Deno.serve(
        { port: 0, onListen: () => {} },
        () => new Response('boom', { status: 500 }),
    );
    const addr = server.addr;
    const env = await makeTestEnv({
        symbolicatorUrl: `http://127.0.0.1:${addr.port}`,
        maxAttempts: 2,
    });
    try {
        await insertPendingReport(env, crypto.randomUUID());
        const [first] = env.db.claimPending(1, Date.now());
        await processReport({
            db: env.db,
            config: env.config,
            pollIntervalMs: 5,
        }, first);

        let row = env.db.getReport(first.id)!;
        assertEquals(row.status, 'pending');
        assertEquals(row.attempts, 1);
        assert(row.error && row.error.includes('500'));
        assert(
            row.next_attempt_at > Date.now(),
            'retry should be scheduled in the future',
        );
        assertEquals(
            env.db.claimPending(1, Date.now()).length,
            0,
            'not claimable before backoff elapses',
        );

        const [second] = env.db.claimPending(1, row.next_attempt_at + 1);
        assert(second);
        await processReport({
            db: env.db,
            config: env.config,
            pollIntervalMs: 5,
        }, second);
        row = env.db.getReport(first.id)!;
        assertEquals(row.status, 'failed');
        assertEquals(row.attempts, 2);
    } finally {
        await server.shutdown();
        await env.cleanup();
    }
});

Deno.test('retention deletes old dumps but keeps metadata', async () => {
    const env = await makeTestEnv({ retentionDays: 30 });
    try {
        const oldId = crypto.randomUUID();
        const newId = crypto.randomUUID();
        // The old report predates the retention window.
        await insertPendingReport(
            env,
            oldId,
            Date.now() - 31 * 24 * 60 * 60 * 1000,
        );
        await insertPendingReport(env, newId);

        const deleted = await runRetention(env.db, env.config);
        assertEquals(deleted, 1);
        assertEquals(env.db.getReport(oldId)!.dump_deleted, 1);
        assertEquals(env.db.getReport(newId)!.dump_deleted, 0);
        await Deno.stat(dumpPath(env.dir, newId)); // still there
        let gone = false;
        try {
            await Deno.stat(dumpPath(env.dir, oldId));
        } catch {
            gone = true;
        }
        assert(gone, 'old dump file should be removed');
    } finally {
        await env.cleanup();
    }
});

Deno.test('symbols upload requeues unsymbolicated reports, which then regroup', async () => {
    const unsymbolicated = JSON.stringify({
        status: 'completed',
        system_info: { os_name: 'macOS 26.5.1', cpu_arch: 'arm64' },
        crash_reason: 'EXC_BREAKPOINT (SIGTRAP)',
        modules: [{
            code_file: '/app/Helium',
            image_addr: '0x100000000',
            image_size: 1048576,
        }],
        stacktraces: [{
            thread_id: 0,
            is_requesting: true,
            frames: [{
                status: 'missing',
                package: '/app/Helium',
                instruction_addr: '0x100001234',
            }],
        }],
    });
    const symbolicated = JSON.stringify({
        status: 'completed',
        system_info: { os_name: 'macOS 26.5.1', cpu_arch: 'arm64' },
        crash_reason: 'EXC_BREAKPOINT (SIGTRAP)',
        stacktraces: [{
            thread_id: 0,
            is_requesting: true,
            frames: [{
                status: 'symbolicated',
                package: '/app/Helium',
                function: 'HeliumThing::Explode()',
                instruction_addr: '0x100001234',
            }],
        }],
    });
    let withSymbols = false;
    const server = Deno.serve(
        { port: 0, onListen: () => {} },
        () =>
            new Response(withSymbols ? symbolicated : unsymbolicated, {
                headers: { 'content-type': 'application/json' },
            }),
    );
    const env = await makeTestEnv({
        symbolicatorUrl: `http://127.0.0.1:${server.addr.port}`,
    });
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
        const [first] = env.db.claimPending(1, Date.now());
        await processReport(
            { db: env.db, config: env.config, pollIntervalMs: 5 },
            first,
        );
        let row = env.db.getReport(id)!;
        assertEquals(row.status, 'processed');
        assertEquals(row.symbolicated, 0);
        const junkGroupId = row.group_id!;

        // Symbols arrive (product name cased differently, as CI would send).
        const notBefore = Date.now() + 50;
        assertEquals(
            env.db.requeueUnsymbolicated('helium', '0.14.3.1', notBefore),
            1,
        );
        assertEquals(env.db.getReport(id)!.status, 'pending');
        assertEquals(
            env.db.claimPending(1, Date.now()).length,
            0,
            'not claimable before the negative-cache delay',
        );

        withSymbols = true;
        const [second] = env.db.claimPending(1, notBefore + 1);
        assert(second);
        await processReport(
            { db: env.db, config: env.config, pollIntervalMs: 5 },
            second,
        );
        row = env.db.getReport(id)!;
        assertEquals(row.status, 'processed');
        assertEquals(row.symbolicated, 1);
        assert(row.group_id !== junkGroupId, 'report moved to a new group');
        assertEquals(
            env.db.getGroup(row.group_id!)!.title,
            'HeliumThing::Explode()',
        );
        assertEquals(env.db.getGroup(row.group_id!)!.report_count, 1);
        assertEquals(
            env.db.getGroup(junkGroupId),
            null,
            'drained group is pruned',
        );
        // Nothing left to requeue.
        assertEquals(
            env.db.requeueUnsymbolicated('helium', '0.14.3.1', notBefore),
            0,
        );
    } finally {
        await server.shutdown();
        await env.cleanup();
    }
});

Deno.test('symbol retention expires old bundles but keeps shared debug files', async () => {
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
        await Deno.utime(`${symRoot}/bundles/helium-1.0.0`, past, past);

        // Debug file only in the old build → should be deleted entirely.
        await mk('aa/aa1111/debuginfo');
        await mk('aa/aa1111/refs/helium-1.0.0');
        // Debug file shared by both builds → keeps its dir, loses the old ref.
        await mk('bb/bb2222/debuginfo');
        await mk('bb/bb2222/refs/helium-1.0.0');
        await mk('bb/bb2222/refs/helium-2.0.0');

        const result = await runSymbolRetention(env.config);
        assertEquals(result.bundles, 1);
        assertEquals(result.debugDirs, 1);

        let oldGone = false;
        try {
            await Deno.stat(`${symRoot}/aa`);
        } catch {
            oldGone = true;
        }
        assert(oldGone, 'old-only debug dir and its shard should be removed');
        await Deno.stat(`${symRoot}/bb/bb2222/debuginfo`); // still there
        await Deno.stat(`${symRoot}/bb/bb2222/refs/helium-2.0.0`);
        let refGone = false;
        try {
            await Deno.stat(`${symRoot}/bb/bb2222/refs/helium-1.0.0`);
        } catch {
            refGone = true;
        }
        assert(
            refGone,
            'expired ref on the shared debug file should be removed',
        );
        let bundleGone = false;
        try {
            await Deno.stat(`${symRoot}/bundles/helium-1.0.0`);
        } catch {
            bundleGone = true;
        }
        assert(bundleGone, 'expired bundle meta should be removed');
        await Deno.stat(`${symRoot}/bundles/helium-2.0.0`);

        // Second run is a no-op.
        assertEquals((await runSymbolRetention(env.config)).bundles, 0);

        // Disabled retention never deletes.
        const off = await runSymbolRetention({
            ...env.config,
            symbolsRetentionDays: 0,
        });
        assertEquals(off.bundles, 0);
    } finally {
        await env.cleanup();
    }
});
