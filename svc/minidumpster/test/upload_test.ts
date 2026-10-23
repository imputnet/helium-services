import { assert, assertEquals, assertFalse, assertRejects } from '@std/assert';
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
    dirEntries,
    encodeMultipart,
    makeTestEnv,
    testSessionCookie,
} from './helpers.ts';

Deno.test('pasted Apple crash reports are filed and deduped by incident id', async () => {
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
        assertEquals(again.status, 302);
        assertEquals(again.headers.get('location'), `/reports/${id}`);

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
        assertEquals(retry.status, 302);
        assertEquals(retry.headers.get('location'), `/reports/${id}`);
        const requeued = env.db.getReport(id)!;
        assertEquals(requeued.status, 'pending');
        assertEquals(requeued.error, 'requeued by re-upload');
        assertEquals(requeued.attempts, 0);
    } finally {
        await env.cleanup();
    }
});

Deno.test('upload rejects non-crash-report input and requires a session', async () => {
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
        assertEquals(bad.status, 400);
        assert((await bad.text()).includes('does not look like'));

        const anon = await app.request('/upload', { method: 'POST' });
        assertEquals(anon.status, 302);
        assertEquals(anon.headers.get('location'), '/auth/login');
    } finally {
        await env.cleanup();
    }
});

Deno.test('manual upload streams without Content-Length and enforces UTF-8 bytes', async () => {
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
        });
        assertEquals(ok.status, 302);

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
        });
        assertEquals(rejected.status, 413);
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
        assertEquals(fileRejected.status, 413);
        await fileRejected.body?.cancel();
        assertEquals(await dirEntries(tmpDir(env.dir)), []);
    } finally {
        await env.cleanup();
    }
});

Deno.test('manual upload removes the payload when database insertion fails', async () => {
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
        assertEquals(res.status, 500);
        await res.body?.cancel();
        for (const shard of await dirEntries(`${env.dir}/dumps`)) {
            assertEquals(await dirEntries(`${env.dir}/dumps/${shard}`), []);
        }
        assertEquals(await dirEntries(tmpDir(env.dir)), []);
    } finally {
        await env.cleanup();
    }
});

Deno.test('authenticated report responses are not cached', async () => {
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
        assertEquals(
            initialPage.headers.get('cache-control'),
            'private, no-store',
        );
        assert((await initialPage.text()).includes('Open GitHub issue'));

        const dump = await app.request(`/reports/${id}/dump`, {
            headers: { cookie },
        });
        assertEquals(dump.status, 200);
        assertEquals(dump.headers.get('cache-control'), 'private, no-store');
        assertEquals(await dump.text(), 'raw');

        const processed = await app.request(`/reports/${id}/json`, {
            headers: { cookie },
        });
        assertEquals(processed.status, 200);
        assertEquals(
            processed.headers.get('cache-control'),
            'private, no-store',
        );
        assertEquals(await processed.text(), '{}');
    } finally {
        await env.cleanup();
    }
});

Deno.test('processed reports can be manually requeued', async () => {
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
        assertFalse(pageText.includes('Open GitHub issue'));

        const response = await app.request(`/reports/${id}/reprocess`, {
            method: 'POST',
            headers: { cookie },
        });
        assertEquals(response.status, 303);
        assertEquals(response.headers.get('location'), `/reports/${id}`);

        const requeued = env.db.getReport(id)!;
        assertEquals(requeued.status, 'pending');
        assertEquals(requeued.attempts, 0);
        assertEquals(requeued.next_attempt_at, 0);
        assertEquals(requeued.group_id, null);
        const group = env.db.getGroup(groupId)!;
        assertEquals(group.report_count, 1);
        assertEquals(group.first_seen, remainingAt);
        assertEquals(group.last_seen, remainingAt);

        const again = await app.request(`/reports/${id}/reprocess`, {
            method: 'POST',
            headers: { cookie },
        });
        assertEquals(again.status, 409);
    } finally {
        await env.cleanup();
    }
});

Deno.test('reports can be deleted and empty groups are pruned', async () => {
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
        assertEquals(first.status, 303);
        assertEquals(first.headers.get('location'), `/groups/${groupId}`);
        assertEquals(env.db.getReport(ids[0]), null);
        assertEquals(env.db.getGroup(groupId)?.report_count, 1);
        await assertRejects(
            () => Deno.stat(dumpPath(env.dir, ids[0])),
            Deno.errors.NotFound,
        );
        await assertRejects(
            () => Deno.stat(processedPath(env.dir, ids[0])),
            Deno.errors.NotFound,
        );

        const second = await app.request(`/reports/${ids[1]}/delete`, {
            method: 'POST',
            headers: { cookie },
        });
        assertEquals(second.status, 303);
        assertEquals(second.headers.get('location'), '/');
        assertEquals(env.db.getReport(ids[1]), null);
        assertEquals(env.db.getGroup(groupId), null);
    } finally {
        await env.cleanup();
    }
});

Deno.test('groups can be deleted with all reports and payloads', async () => {
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
        assertEquals(response.status, 303);
        assertEquals(response.headers.get('location'), '/');
        assertEquals(env.db.getGroup(groupId), null);
        assertEquals(env.db.searchReports('GroupCrash'), []);
        for (const id of ids) {
            assertEquals(env.db.getReport(id), null);
            await assertRejects(
                () => Deno.stat(dumpPath(env.dir, id)),
                Deno.errors.NotFound,
            );
            await assertRejects(
                () => Deno.stat(processedPath(env.dir, id)),
                Deno.errors.NotFound,
            );
        }
    } finally {
        await env.cleanup();
    }
});

Deno.test('all reports in a group can be manually requeued', async () => {
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
        assertEquals(response.status, 303);
        assertEquals(response.headers.get('location'), '/');
        assertEquals(env.db.getGroup(groupId), null);
        for (const id of ids) {
            const report = env.db.getReport(id)!;
            assertEquals(report.status, 'pending');
            assertEquals(report.group_id, null);
            assertEquals(report.attempts, 0);
            assertEquals(report.next_attempt_at, 0);
        }

        const again = await app.request(`/groups/${groupId}/reprocess`, {
            method: 'POST',
            headers: { cookie },
        });
        assertEquals(again.status, 404);
    } finally {
        await env.cleanup();
    }
});

Deno.test('worker symbolicates Apple reports via /applecrashreport', async () => {
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
        assertEquals(claimed.id, id);
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
        await env.cleanup();
    }
});

Deno.test('search finds reports by id, guid, and function name', async () => {
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
        assertEquals(byId.status, 302);
        assertEquals(byId.headers.get('location'), `/reports/${id}`);

        // 8-char prefix, as shown in the UI -> redirect.
        const byPrefix = await app.request(`/search?q=${id.slice(0, 8)}`, {
            headers: { cookie },
        });
        assertEquals(byPrefix.status, 302);
        assertEquals(byPrefix.headers.get('location'), `/reports/${id}`);

        // Guid (lowercased by the user) -> redirect.
        const byGuid = await app.request(`/search?q=${guid.toLowerCase()}`, {
            headers: { cookie },
        });
        assertEquals(byGuid.status, 302);
        assertEquals(byGuid.headers.get('location'), `/reports/${id}`);

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
        assertEquals(byFunction.status, 302);
        assertEquals(byFunction.headers.get('location'), `/reports/${id}`);

        const byQualifiedFunction = await app.request(
            `/search?${new URLSearchParams({
                q: 'content::RenderWidgetHostImpl::OnKeyboardEvent()',
            })}`,
            { headers: { cookie } },
        );
        assertEquals(byQualifiedFunction.status, 302);
        assertEquals(
            byQualifiedFunction.headers.get('location'),
            `/reports/${id}`,
        );

        // A function below the signature frame still finds the group through
        // the indexed stacks of its reports.
        const byLowerFrame = await app.request(
            `/search?${new URLSearchParams({ q: 'LowerStackFunction' })}`,
            { headers: { cookie } },
        );
        assertEquals(byLowerFrame.status, 302);
        assertEquals(byLowerFrame.headers.get('location'), `/reports/${id}`);

        const uniqueGroupId = env.db.upsertGroup(
            'unique-group-signature',
            'content::UniqueGroupSearchResult()',
            Date.now(),
        );
        const uniqueGroup = await app.request(
            '/search?q=UniqueGroupSearchResult',
            { headers: { cookie } },
        );
        assertEquals(uniqueGroup.status, 302);
        assertEquals(
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
        assertEquals(sharedGroups.status, 200);
        const sharedGroupResults = await sharedGroups.text();
        assert(sharedGroupResults.includes('Groups'));
        assert(sharedGroupResults.includes(`/groups/${firstSharedGroupId}`));
        assert(sharedGroupResults.includes(`/groups/${secondSharedGroupId}`));

        // No match -> results page, not an error.
        const none = await app.request('/search?q=ffffffff', {
            headers: { cookie },
        });
        assertEquals(none.status, 200);
        assert((await none.text()).includes('No groups or reports match'));

        // Short queries are allowed.
        const short = await app.request('/search?q=ab', {
            headers: { cookie },
        });
        assertEquals(short.status, 200);
        assert((await short.text()).includes('No groups or reports match'));

        const shortFunction = await app.request('/search?q=Run', {
            headers: { cookie },
        });
        assertEquals(shortFunction.status, 302);
        assertEquals(shortFunction.headers.get('location'), `/reports/${id}`);

        // An empty query is not a search.
        const empty = await app.request('/search?q=', {
            headers: { cookie },
        });
        assertEquals(empty.status, 400);
        await empty.body?.cancel();
    } finally {
        await env.cleanup();
    }
});
