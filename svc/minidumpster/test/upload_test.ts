import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { buildApp } from '../src/app.ts';
import {
    dbPath,
    dumpPath,
    processedPath,
    tmpDir,
    writeFileWithDirs,
} from '../src/paths.ts';
import { processReport } from '../src/worker.ts';
import {
    appleCrashFixture,
    appleFixtureResponse,
    chunked,
    encodeMultipart,
    makeTestEnv,
    testSessionCookie,
} from './helpers.ts';

test('pasted Apple crash reports are filed and deduped by incident id', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const form = new FormData();
        form.append('text', await appleCrashFixture());
        const res = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: form,
        });
        assert.equal(res.status, 302);
        const location = res.headers.get('location')!;
        assert(location.startsWith('/reports/'));
        const id = location.slice('/reports/'.length);

        const row = env.db.getReport(id)!;
        assert.equal(row.kind, 'apple');
        assert.equal(row.status, 'pending');
        assert.equal(row.product, 'Helium');
        assert.equal(row.version, '0.14.3.1');
        assert.equal(row.guid, '893ED25D-2D48-4068-9451-7BB173D52BDD');
        const annotations = JSON.parse(row.annotations) as Record<
            string,
            string
        >;
        assert.equal(annotations['uploaded_by'], 'jj');
        assert.equal(annotations['bundle_id'], 'net.imput.helium');
        const stored = await readFile(dumpPath(env.dir, id), 'utf8');
        assert(stored.includes('Thread 0 Crashed'));

        // Same incident again -> redirected to the existing report.
        const again = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: (() => {
                const f = new FormData();
                f.append('text', stored);
                return f;
            })(),
        });
        assert.equal(again.status, 302);
        assert.deepStrictEqual(again.headers.get('location'), `/reports/${id}`);

        const legacyDb = new DatabaseSync(dbPath(env.dir));
        try {
            legacyDb
                .prepare(
                    `UPDATE reports
                 SET status = 'failed', error = 'old failure', attempts = 5
                 WHERE id = ?`,
                )
                .run(id);
        } finally {
            legacyDb.close();
        }

        const retryForm = new FormData();
        retryForm.append('text', stored);
        const retry = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: retryForm,
        });
        assert.equal(retry.status, 302);
        assert.deepStrictEqual(retry.headers.get('location'), `/reports/${id}`);
        const requeued = env.db.getReport(id)!;
        assert.equal(requeued.status, 'pending');
        assert.equal(requeued.error, 'requeued by re-upload');
        assert.equal(requeued.attempts, 0);
    } finally {
        await env.cleanup();
    }
});

test('upload rejects non-crash-report input and requires a session', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);

        const form = new FormData();
        form.append('text', '{"app_name":"Helium","bug_type":"309"}');
        const bad = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: form,
        });
        assert.equal(bad.status, 400);
        assert((await bad.text()).includes('does not look like'));

        const anon = await app.request('/upload', { method: 'POST' });
        assert.equal(anon.status, 302);
        assert.equal(anon.headers.get('location'), '/auth/login');
    } finally {
        await env.cleanup();
    }
});

test('manual upload streams without Content-Length and enforces UTF-8 bytes', async () => {
    const fixtureText = await appleCrashFixture();
    const submitted = fixtureText.trim();
    const normalized = submitted.replace(/\r?\n/g, '\r\n');
    const fixtureBytes = new TextEncoder().encode(normalized).length;
    const env = await makeTestEnv({ maxDumpSizeBytes: fixtureBytes });
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const form = new FormData();
        form.append('text', submitted);
        const encoded = await encodeMultipart(form);
        const ok = await app.request('/upload', {
            method: 'POST',
            headers: {
                cookie,
                'content-type': encoded.contentType,
            },
            body: chunked(encoded.bytes, 17),
            duplex: 'half',
        });
        assert.equal(ok.status, 302);

        const oversized = new FormData();
        oversized.append('text', `${submitted}\u{e9}`);
        const tooLarge = await encodeMultipart(oversized);
        const rejected = await app.request('/upload', {
            method: 'POST',
            headers: {
                cookie,
                'content-type': tooLarge.contentType,
            },
            body: chunked(tooLarge.bytes, 11),
            duplex: 'half',
        });
        assert.equal(rejected.status, 413);
        await rejected.body?.cancel();

        const oversizedFile = new FormData();
        oversizedFile.append(
            'file',
            new Blob([`${normalized}\u{e9}`]),
            'report.crash',
        );
        const fileRejected = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: oversizedFile,
        });
        assert.equal(fileRejected.status, 413);
        await fileRejected.body?.cancel();
        assert.deepStrictEqual(await readdir(tmpDir(env.dir)), []);
    } finally {
        await env.cleanup();
    }
});

test('manual upload removes the payload when database insertion fails', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        env.db.insertReport = () => {
            throw new Error('simulated database failure');
        };
        const form = new FormData();
        form.append('text', await appleCrashFixture());
        const res = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: form,
        });
        assert.equal(res.status, 500);
        await res.body?.cancel();
        for (const shard of await readdir(`${env.dir}/dumps`)) {
            assert.deepStrictEqual(
                await readdir(`${env.dir}/dumps/${shard}`),
                [],
            );
        }
        assert.deepStrictEqual(await readdir(tmpDir(env.dir)), []);
    } finally {
        await env.cleanup();
    }
});

test('authenticated report responses are not cached', async () => {
    const env = await makeTestEnv({
        githubIssueRepo: 'imputnet/helium',
        githubIssueTemplate: 'bug-report.yml',
    });
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const id = crypto.randomUUID();
        const receivedAt = Date.now();
        await writeFileWithDirs(dumpPath(env.dir, id), 'raw');
        await writeFileWithDirs(processedPath(env.dir, id), '{}');
        env.db.insertReport({
            id,
            product: 'Helium',
            version: '1.0',
            guid: 'incident',
            ptype: null,
            channel: null,
            annotations: JSON.stringify({ uploaded_by: 'jj' }),
            received_at: receivedAt,
        });
        const group = env.db.upsertGroup(
            'retention-ui',
            'retention',
            Date.now(),
        );
        env.db.markProcessed(id, group, 'macOS', Date.now(), true, 1);

        const initialPage = await app.request(`/reports/${id}`, {
            headers: { cookie },
        });
        assert.deepStrictEqual(
            initialPage.headers.get('cache-control'),
            'private, no-store',
        );
        assert((await initialPage.text()).includes('Open GitHub issue'));

        const dump = await app.request(`/reports/${id}/dump`, {
            headers: { cookie },
        });
        assert.equal(dump.status, 200);
        assert.equal(dump.headers.get('cache-control'), 'private, no-store');
        assert.equal(await dump.text(), 'raw');

        const processed = await app.request(`/reports/${id}/json`, {
            headers: { cookie },
        });
        assert.equal(processed.status, 200);
        assert.deepStrictEqual(
            processed.headers.get('cache-control'),
            'private, no-store',
        );
        assert.equal(await processed.text(), '{}');
    } finally {
        await env.cleanup();
    }
});

test('processed reports can be manually requeued', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const id = crypto.randomUUID();
        const remainingId = crypto.randomUUID();
        const remainingAt = Date.now() - 60_000;
        const requeuedAt = Date.now();
        await writeFileWithDirs(dumpPath(env.dir, id), 'raw');
        await writeFileWithDirs(
            processedPath(env.dir, id),
            JSON.stringify({ status: 'completed', stacktraces: [] }),
        );
        env.db.insertReport({
            id,
            product: 'Helium',
            version: '1.0',
            guid: null,
            ptype: null,
            channel: null,
            annotations: '{}',
            received_at: requeuedAt,
        });
        const groupId = env.db.upsertGroup(
            'manual-requeue',
            'Crash()',
            requeuedAt,
        );
        env.db.insertReport({
            id: remainingId,
            product: 'Helium',
            version: '1.0',
            guid: null,
            ptype: null,
            channel: null,
            annotations: '{}',
            received_at: remainingAt,
        });
        env.db.markProcessed(
            remainingId,
            groupId,
            'macOS',
            remainingAt,
            true,
            1,
        );
        env.db.markProcessed(id, groupId, 'macOS', requeuedAt, true, 3);
        env.db.recountGroups([groupId]);

        const page = await app.request(`/reports/${id}`, {
            headers: { cookie },
        });
        const pageText = await page.text();
        assert(pageText.includes('Reprocess report'));
        assert.ok(!pageText.includes('Open GitHub issue'));

        const response = await app.request(`/reports/${id}/reprocess`, {
            method: 'POST',
            headers: { cookie },
        });
        assert.equal(response.status, 303);
        assert.deepStrictEqual(
            response.headers.get('location'),
            `/reports/${id}`,
        );

        const requeued = env.db.getReport(id)!;
        assert.equal(requeued.status, 'pending');
        assert.equal(requeued.attempts, 0);
        assert.equal(requeued.next_attempt_at, 0);
        assert.equal(requeued.group_id, null);
        const group = env.db.getGroup(groupId)!;
        assert.equal(group.report_count, 1);
        assert.deepStrictEqual(group.first_seen, remainingAt);
        assert.deepStrictEqual(group.last_seen, remainingAt);

        const again = await app.request(`/reports/${id}/reprocess`, {
            method: 'POST',
            headers: { cookie },
        });
        assert.equal(again.status, 409);
    } finally {
        await env.cleanup();
    }
});

test('reports can be deleted and empty groups are pruned', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const ids = [crypto.randomUUID(), crypto.randomUUID()];
        const groupId = env.db.upsertGroup(
            'report-delete',
            'Crash()',
            Date.now(),
        );
        for (const id of ids) {
            await writeFileWithDirs(dumpPath(env.dir, id), 'raw');
            await writeFileWithDirs(processedPath(env.dir, id), '{}');
            env.db.insertReport({
                id,
                product: 'Helium',
                version: '1.0',
                guid: null,
                ptype: null,
                channel: null,
                annotations: '{}',
                received_at: Date.now(),
            });
            env.db.markProcessed(id, groupId, 'Windows', Date.now(), true, 1);
        }
        env.db.recountGroups([groupId]);

        const page = await app.request(`/reports/${ids[0]}`, {
            headers: { cookie },
        });
        assert((await page.text()).includes('Delete report'));

        const first = await app.request(`/reports/${ids[0]}/delete`, {
            method: 'POST',
            headers: { cookie },
        });
        assert.equal(first.status, 303);
        assert.deepStrictEqual(
            first.headers.get('location'),
            `/groups/${groupId}`,
        );
        assert.equal(env.db.getReport(ids[0]), null);
        assert.equal(env.db.getGroup(groupId)?.report_count, 1);
        await assert.rejects(stat(dumpPath(env.dir, ids[0])), {
            code: 'ENOENT',
        });
        await assert.rejects(stat(processedPath(env.dir, ids[0])), {
            code: 'ENOENT',
        });

        const second = await app.request(`/reports/${ids[1]}/delete`, {
            method: 'POST',
            headers: { cookie },
        });
        assert.equal(second.status, 303);
        assert.equal(second.headers.get('location'), '/');
        assert.equal(env.db.getReport(ids[1]), null);
        assert.equal(env.db.getGroup(groupId), null);
    } finally {
        await env.cleanup();
    }
});

test('groups can be deleted with all reports and payloads', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const ids = [crypto.randomUUID(), crypto.randomUUID()];
        const groupId = env.db.upsertGroup(
            'group-delete',
            'GroupCrash()',
            Date.now(),
        );
        for (const id of ids) {
            await writeFileWithDirs(dumpPath(env.dir, id), 'raw');
            await writeFileWithDirs(processedPath(env.dir, id), '{}');
            env.db.insertReport({
                id,
                product: 'Helium',
                version: '1.0',
                guid: null,
                ptype: null,
                channel: null,
                annotations: '{}',
                received_at: Date.now(),
            });
            env.db.markProcessed(id, groupId, 'Windows', Date.now(), true, 1);
            env.db.indexReportFunctions(id, 'GroupCrash');
        }
        env.db.recountGroups([groupId]);

        const page = await app.request(`/groups/${groupId}`, {
            headers: { cookie },
        });
        assert((await page.text()).includes('Delete group'));

        const response = await app.request(`/groups/${groupId}/delete`, {
            method: 'POST',
            headers: { cookie },
        });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/');
        assert.equal(env.db.getGroup(groupId), null);
        assert.deepStrictEqual(env.db.searchReports('GroupCrash'), []);
        for (const id of ids) {
            assert.equal(env.db.getReport(id), null);
            await assert.rejects(stat(dumpPath(env.dir, id)), {
                code: 'ENOENT',
            });
            await assert.rejects(stat(processedPath(env.dir, id)), {
                code: 'ENOENT',
            });
        }
    } finally {
        await env.cleanup();
    }
});

test('all reports in a group can be manually requeued', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const ids = [crypto.randomUUID(), crypto.randomUUID()];
        const groupId = env.db.upsertGroup(
            'group-reprocess',
            'operator()',
            Date.now(),
        );
        for (const [index, id] of ids.entries()) {
            await writeFileWithDirs(dumpPath(env.dir, id), 'raw');
            await writeFileWithDirs(
                processedPath(env.dir, id),
                JSON.stringify({ status: 'completed', stacktraces: [] }),
            );
            env.db.insertReport({
                id,
                product: 'Helium',
                version: '1.0',
                guid: null,
                ptype: null,
                channel: null,
                annotations: '{}',
                received_at: Date.now() + index,
            });
            env.db.markProcessed(id, groupId, 'macOS', Date.now(), true, 3);
        }
        env.db.recountGroups([groupId]);

        const page = await app.request(`/groups/${groupId}`, {
            headers: { cookie },
        });
        assert((await page.text()).includes('Reprocess group'));

        const response = await app.request(`/groups/${groupId}/reprocess`, {
            method: 'POST',
            headers: { cookie },
        });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/');
        assert.equal(env.db.getGroup(groupId), null);
        for (const id of ids) {
            const report = env.db.getReport(id)!;
            assert.equal(report.status, 'pending');
            assert.equal(report.group_id, null);
            assert.equal(report.attempts, 0);
            assert.equal(report.next_attempt_at, 0);
        }

        const again = await app.request(`/groups/${groupId}/reprocess`, {
            method: 'POST',
            headers: { cookie },
        });
        assert.equal(again.status, 404);
    } finally {
        await env.cleanup();
    }
});

test('worker symbolicates Apple reports via /applecrashreport', async () => {
    const appleResponse = await appleFixtureResponse();
    let normalizedSeen = '';
    const fetchFn = (async (
        input: string | URL | Request,
        init?: RequestInit,
    ) => {
        const url = new URL(String(input));
        if (init?.method === 'POST' && url.pathname === '/applecrashreport') {
            const form = init.body;
            assert(form instanceof FormData);
            const part = form.get('apple_crash_report');
            normalizedSeen = part instanceof File ? await part.text() : '';
            return new Response(appleResponse, {
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response('wrong endpoint', { status: 404 });
    }) as typeof fetch;
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const form = new FormData();
        form.append('text', await appleCrashFixture());
        const res = await app.request('/upload', {
            method: 'POST',
            headers: { cookie },
            body: form,
        });
        const id = res.headers.get('location')!.slice('/reports/'.length);

        const claimed = env.db.claimNext(Date.now())!;
        assert.deepStrictEqual(claimed.id, id);
        await processReport(
            {
                db: env.db,
                config: env.config,
                fetchFn,
                pollIntervalMs: 5,
            },
            claimed,
        );

        // The worker sent the normalized (classic-format) report.
        assert(normalizedSeen.includes('net.imput.helium.framework arm64'));
        assert(!normalizedSeen.includes('Full Report'));

        const row = env.db.getReport(id)!;
        assert.equal(row.status, 'processed');
        assert.equal(row.platform, 'macOS');
        const group = env.db.getGroup(row.group_id!)!;
        // Product hint keeps Helium frames; the CHECK-machinery top frame
        // (logging::LogMessage::~LogMessage) is skipped as a sentinel.
        assert.deepStrictEqual(
            group.title,
            'content::RenderWidgetHostImpl::OnKeyboardEvent()',
        );

        // The report page shows product, version, and platform.
        const page = await app.request(`/reports/${id}`, {
            headers: { cookie },
        });
        assert.equal(page.status, 200);
        const html = await page.text();
        assert(html.includes('Helium 0.14.3.1'));
        assert(html.includes('macOS'));
    } finally {
        await env.cleanup();
    }
});

test('search finds reports by id, guid, and function name', async () => {
    const env = await makeTestEnv();
    try {
        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
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

        // Full id -> direct redirect (case-insensitive).
        const byId = await app.request(`/search?q=${id.toUpperCase()}`, {
            headers: { cookie },
        });
        assert.equal(byId.status, 302);
        assert.deepStrictEqual(byId.headers.get('location'), `/reports/${id}`);

        // 8-char prefix, as shown in the UI -> redirect.
        const byPrefix = await app.request(`/search?q=${id.slice(0, 8)}`, {
            headers: { cookie },
        });
        assert.equal(byPrefix.status, 302);
        assert.deepStrictEqual(
            byPrefix.headers.get('location'),
            `/reports/${id}`,
        );

        // Guid (lowercased by the user) -> redirect.
        const byGuid = await app.request(`/search?q=${guid.toLowerCase()}`, {
            headers: { cookie },
        });
        assert.equal(byGuid.status, 302);
        assert.deepStrictEqual(
            byGuid.headers.get('location'),
            `/reports/${id}`,
        );

        const groupId = env.db.upsertGroup(
            'search-function',
            'content::RenderWidgetHostImpl::OnKeyboardEvent()',
            Date.now(),
        );
        env.db.markProcessed(id, groupId, 'Windows', Date.now(), true, 1);
        env.db.indexReportFunctions(
            id,
            [
                'content::RenderWidgetHostImpl::OnKeyboardEvent()',
                'content::LowerStackFunction::Run()',
            ].join('\n'),
        );

        const byFunction = await app.request(
            `/search?${new URLSearchParams({
                q: 'RenderWidgetHostImpl',
            })}`,
            { headers: { cookie } },
        );
        assert.equal(byFunction.status, 302);
        assert.deepStrictEqual(
            byFunction.headers.get('location'),
            `/reports/${id}`,
        );

        const byQualifiedFunction = await app.request(
            `/search?${new URLSearchParams({
                q: 'content::RenderWidgetHostImpl::OnKeyboardEvent()',
            })}`,
            { headers: { cookie } },
        );
        assert.equal(byQualifiedFunction.status, 302);
        assert.deepStrictEqual(
            byQualifiedFunction.headers.get('location'),
            `/reports/${id}`,
        );

        // A function below the signature frame still finds the group through
        // the indexed stacks of its reports.
        const byLowerFrame = await app.request(
            `/search?${new URLSearchParams({ q: 'LowerStackFunction' })}`,
            { headers: { cookie } },
        );
        assert.equal(byLowerFrame.status, 302);
        assert.deepStrictEqual(
            byLowerFrame.headers.get('location'),
            `/reports/${id}`,
        );

        const uniqueGroupId = env.db.upsertGroup(
            'unique-group-signature',
            'content::UniqueGroupSearchResult()',
            Date.now(),
        );
        const uniqueGroup = await app.request(
            '/search?q=UniqueGroupSearchResult',
            { headers: { cookie } },
        );
        assert.equal(uniqueGroup.status, 302);
        assert.deepStrictEqual(
            uniqueGroup.headers.get('location'),
            `/groups/${uniqueGroupId}`,
        );

        const firstSharedGroupId = env.db.upsertGroup(
            'shared-group-signature-1',
            'content::SharedGroupSearchResultOne()',
            Date.now(),
        );
        const secondSharedGroupId = env.db.upsertGroup(
            'shared-group-signature-2',
            'content::SharedGroupSearchResultTwo()',
            Date.now(),
        );
        const sharedGroups = await app.request(
            '/search?q=SharedGroupSearchResult',
            { headers: { cookie } },
        );
        assert.equal(sharedGroups.status, 200);
        const sharedGroupResults = await sharedGroups.text();
        assert(sharedGroupResults.includes('Groups'));
        assert(sharedGroupResults.includes(`/groups/${firstSharedGroupId}`));
        assert(sharedGroupResults.includes(`/groups/${secondSharedGroupId}`));

        // No match -> results page, not an error.
        const none = await app.request('/search?q=ffffffff', {
            headers: { cookie },
        });
        assert.equal(none.status, 200);
        assert((await none.text()).includes('No groups or reports match'));

        // Short queries are allowed.
        const short = await app.request('/search?q=ab', {
            headers: { cookie },
        });
        assert.equal(short.status, 200);
        assert((await short.text()).includes('No groups or reports match'));

        const shortFunction = await app.request('/search?q=Run', {
            headers: { cookie },
        });
        assert.equal(shortFunction.status, 302);
        assert.deepStrictEqual(
            shortFunction.headers.get('location'),
            `/reports/${id}`,
        );

        // An empty query is not a search.
        const empty = await app.request('/search?q=', {
            headers: { cookie },
        });
        assert.equal(empty.status, 400);
        await empty.body?.cancel();
    } finally {
        await env.cleanup();
    }
});
