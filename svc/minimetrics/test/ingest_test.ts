import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayOf } from '../src/db.ts';
import { ingestLog } from '../src/ingest.ts';
import { runMaintenance } from '../src/retention.ts';
import {
    encodeLog,
    FCP,
    gzip,
    MEMORY,
    rawRows,
    setup,
    umaRequest,
} from './helpers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function fcpLog(
    clientId: bigint,
    extra: Partial<Parameters<typeof encodeLog>[0]> = {},
) {
    return encodeLog({
        clientId,
        histograms: [{
            hash: FCP,
            sum: 1500,
            buckets: [
                { min: 100, max: 200, count: 2 },
                { min: 200, max: 2000 },
            ],
        }],
        ...extra,
    });
}

test('accepts a Chromium-style upload and aggregates it', async () => {
    await using t = await setup();

    const res = await t.app.request(await umaRequest(fcpLog(1n)));
    assert.deepEqual(res.status, 200);

    const filter = { fromDay: 0 };
    assert.deepEqual(t.db.logCount(filter), 1);
    assert.deepEqual(t.db.buckets(FCP, filter), [
        { min: 100, max: 200, count: 2 },
        { min: 200, max: 2000, count: 1 },
    ]);
    const [row] = t.db.listHistograms(filter);
    assert.deepEqual(
        [row.hash, row.logs, row.samples, row.sum],
        [FCP, 1, 3, 1500],
    );
});

test('stores no raw logs or client ids', async () => {
    await using t = await setup();
    const clientId = 0x1122334455667788n;
    await t.app.request(await umaRequest(fcpLog(clientId)));

    const tables = rawRows<{ name: string }>(
        t.raw,
        `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).map((r) => r.name);

    const needle = new Uint8Array(8);
    new DataView(needle.buffer).setBigUint64(0, clientId, true);
    const hexId = clientId.toString(16);

    for (const table of tables) {
        const stmt = t.raw.prepare(`SELECT * FROM "${table}"`);
        stmt.setReadBigInts(true);

        for (const row of stmt.all()) {
            for (const value of Object.values(row)) {
                assert.notDeepEqual(String(value), String(clientId));
                assert.ok(!String(value).includes(hexId));

                if (value instanceof Uint8Array) {
                    assert.notDeepEqual([...value].join(), [...needle].join());
                }
            }
        }
    }
});

test('drops retried uploads of the same log', async () => {
    await using t = await setup();
    const log = fcpLog(1n);

    assert.deepEqual((await t.app.request(await umaRequest(log))).status, 200);
    assert.deepEqual((await t.app.request(await umaRequest(log))).status, 200);
    assert.deepEqual(t.db.logCount({ fromDay: 0 }), 1);
});

test('rejects bad uploads with 400 so clients discard them', async () => {
    await using t = await setup({ maxLogSizeBytes: 4096 });

    const wrongHash = await umaRequest(fcpLog(1n), {
        'x-chrome-uma-log-sha1': '00'.repeat(20),
    });

    assert.deepEqual((await t.app.request(wrongHash)).status, 400);

    const garbage = new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0x0f]);
    assert.deepEqual(
        (await t.app.request(await umaRequest(garbage))).status,
        400,
    );

    const notGzip = new Request('http://localhost/uma/v2', {
        method: 'POST',
        headers: {
            'content-encoding': 'gzip',
            'x-forwarded-for': '192.0.2.1',
        },
        body: 'hello',
    });

    assert.deepEqual((await t.app.request(notGzip)).status, 400);

    // A gzip bomb is cut off at the decompressed size limit.
    const huge = fcpLog(1n, {
        histograms: Array.from({ length: 2000 }, (_, i) => ({
            hash: BigInt(i + 1),
            buckets: [{ min: 1, max: 2, count: 1 }],
        })),
    });

    assert.deepEqual((await t.app.request(await umaRequest(huge))).status, 400);

    assert.deepEqual(t.db.logCount({ fromDay: 0 }), 0);
});

test('counts distinct daily users and forgets them after the day', async () => {
    await using t = await setup();
    const day0 = Date.UTC(2026, 10, 10, 12);

    const post = async (log: Uint8Array<ArrayBuffer>, now: number) =>
        await ingestLog(await umaRequest(log), t.db, 1 << 20, { now });

    // Client 1 twice (different logs), client 2 once, on a different version.
    await post(fcpLog(1n), day0);
    await post(fcpLog(1n, { channel: 3 }), day0 + 1000);
    await post(fcpLog(2n, { version: '141.0.1.1-64' }), day0 + 2000);
    // No client id: aggregated but not counted as a user.
    await post(fcpLog(0n, { channel: 2 }), day0 + 3000);

    const filter = { fromDay: 0 };
    const d0 = dayOf(day0);
    assert.deepEqual(t.db.dailyUsers(filter).get(d0), 2);
    assert.deepEqual(
        t.db.dailyUsers({ fromDay: 0, version: '141.0.1.1-64' }).get(d0),
        1,
    );
    const salt0 = t.db.saltFor(d0);

    // Next day: same client gets an unrelated hash.
    await post(fcpLog(1n, { channel: 1 }), day0 + DAY_MS);

    const hashes = rawRows<{ day: number; client_hash: Uint8Array }>(
        t.raw,
        'SELECT day, client_hash FROM active_clients ORDER BY day',
    );

    const day1Hash = hashes.find((h) => h.day === d0 + 1)!.client_hash;
    assert.ok(
        hashes.filter((h) => h.day === d0).every((h) =>
            [...h.client_hash].join() !== [...day1Hash].join()
        ),
    );

    // After the day is over, only counts remain.
    runMaintenance(t.db, t.config, day0 + DAY_MS);

    const left = t.raw.prepare(
        'SELECT DISTINCT day FROM active_clients UNION SELECT day FROM day_salts',
    ).all().map((r) => r.day);

    assert.deepEqual(left, [d0 + 1]);
    assert.deepEqual(t.db.dailyUsers(filter).get(d0), 2);
    assert.deepEqual(t.db.dailyUsers(filter).get(d0 + 1), 1);
    assert.deepEqual(
        t.db.dailyUsers({ fromDay: 0, version: '141.0.1.1-64' }).get(d0),
        1,
    );

    // A recreated salt for an old day is new, so old hashes can't be rebuilt.
    assert.notDeepEqual([...t.db.saltFor(d0)].join(), [...salt0].join());
});

test('expires aggregates after the retention period', async () => {
    await using t = await setup({ retentionDays: 30 });
    const old = Date.UTC(2026, 0, 1);
    await ingestLog(await umaRequest(fcpLog(1n)), t.db, 1 << 20, { now: old });
    runMaintenance(t.db, t.config, old + 31 * DAY_MS);

    for (
        const table of [
            'histogram_buckets',
            'histogram_totals',
            'log_counts',
            'daily_users',
            'active_clients',
            'day_salts',
            'segments',
        ]
    ) {
        const [{ n }] = rawRows<{ n: number }>(
            t.raw,
            `SELECT COUNT(*) AS n FROM ${table}`,
        );

        assert.deepEqual(n, 0, table);
    }
});

test('allowlist drops other histograms', async () => {
    await using t = await setup();

    const log = fcpLog(1n, {
        histograms: [
            { hash: FCP, buckets: [{ min: 1, max: 2 }] },
            { hash: MEMORY, buckets: [{ min: 1, max: 2 }] },
        ],
    });

    await ingestLog(await umaRequest(log), t.db, 1 << 20, {
        allow: (h) => h === MEMORY,
    });
    assert.deepEqual(t.db.listHistograms({ fromDay: 0 }).map((r) => r.hash), [
        MEMORY,
    ]);
});

test('imports histogram names behind a token', async () => {
    await using t = await setup();

    const names =
        'Memory.Browser.PrivateMemoryFootprint\n# comment\n\nbad name\n';

    const anon = await t.app.request('/api/histogram-names', {
        method: 'POST',
        body: names,
    });

    assert.deepEqual(anon.status, 401);

    const res = await t.app.request('/api/histogram-names', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${t.config.namesUploadToken}`,
            'content-encoding': 'gzip',
        },
        body: await gzip(new TextEncoder().encode(names)),
    });

    assert.deepEqual(await res.json(), { ok: true, imported: 1, total: 1 });
    assert.deepEqual(
        t.db.nameFor(MEMORY),
        'Memory.Browser.PrivateMemoryFootprint',
    );
});

test('web pages render', async () => {
    await using t = await setup();
    await t.app.request(await umaRequest(fcpLog(1n)));
    t.db.upsertNames([{
        hash: FCP,
        name: 'PageLoad.PaintTiming.NavigationToFirstContentfulPaint',
    }]);

    const overview = await (await t.app.request('/')).text();
    assert.ok(overview.includes('users today'));

    const list = (await (await t.app.request('/histograms?q=PaintTiming'))
        .text()).replaceAll('<wbr>', '');

    assert.ok(
        list.includes('PageLoad.PaintTiming.NavigationToFirstContentfulPaint'),
    );
    assert.ok(list.includes('/h/8559fe6630fce9a7'));

    const detail = await t.app.request('/h/8559fe6630fce9a7?days=30');
    assert.deepEqual(detail.status, 200);
    const html = await detail.text();
    assert.ok(html.includes('100 - 200'));
    assert.deepEqual(
        detail.headers.get('cache-control'),
        'private, no-store',
    );

    assert.deepEqual((await t.app.request('/h/nope')).status, 404);
});

test('hides histogram data for groups under MIN_USERS', async () => {
    await using t = await setup({ minUsers: 3 });
    const now = Date.now();

    const post = async (log: Uint8Array<ArrayBuffer>) =>
        await ingestLog(await umaRequest(log), t.db, 1 << 20, { now });

    // Three users on one version, a single user on a rare dev build.
    for (const id of [1n, 2n, 3n]) {
        await post(fcpLog(id));
    }

    await post(fcpLog(4n, { version: '999.0.0.0-64-devel' }));

    const all = await (await t.app.request('/histograms')).text();
    assert.ok(all.includes('/h/8559fe6630fce9a7'));

    const rare = await (await t.app.request(
        '/histograms?version=999.0.0.0-64-devel',
    )).text();

    assert.ok(rare.includes('daily users match'));
    assert.ok(!rare.includes('/h/8559fe6630fce9a7'));

    const rareDetail = await (await t.app.request(
        '/h/8559fe6630fce9a7?version=999.0.0.0-64-devel',
    )).text();

    assert.ok(rareDetail.includes('daily users match'));

    // The unfiltered page leaves the rare version out of its breakdown.
    const detail = await (await t.app.request('/h/8559fe6630fce9a7')).text();
    assert.ok(!detail.includes('999.0.0.0-64-devel</a>'));
});

test('forgets log fingerprints after the day', async () => {
    await using t = await setup();
    const day0 = Date.UTC(2026, 10, 10, 12);
    await ingestLog(await umaRequest(fcpLog(1n)), t.db, 1 << 20, {
        now: day0,
    });
    runMaintenance(t.db, t.config, day0 + 1000);

    const count = () =>
        rawRows<{ n: number }>(t.raw, 'SELECT COUNT(*) AS n FROM seen_logs')[0]
            .n;

    assert.deepEqual(count(), 1);
    runMaintenance(t.db, t.config, day0 + DAY_MS);
    assert.deepEqual(count(), 0);
});
