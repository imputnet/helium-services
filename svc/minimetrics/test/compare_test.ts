import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseVersions, compareBuckets, mixShift } from '../src/compare.ts';
import { ingestLog } from '../src/ingest.ts';
import { encodeLog, FCP, MEMORY, setup, umaRequest } from './helpers.ts';

const buckets = (counts: number[]) =>
    counts.map((count, i) => ({ min: i * 10, max: i * 10 + 10, count }));

test('same distribution scores within noise', () => {
    const c = compareBuckets(
        buckets([100, 300, 400, 200]),
        buckets([105, 290, 410, 195]),
    );

    assert.equal(c.significant, false, `score ${c.score}`);
    assert.ok(c.shift < 0.02);
});

test('shifted distribution scores above noise', () => {
    const c = compareBuckets(
        buckets([100, 300, 400, 200]),
        buckets([20, 150, 430, 400]),
    );

    assert.equal(c.significant, true, `score ${c.score}`);
    assert.ok(c.p50Change! > 0);
});

test('small samples stay within noise', () => {
    const c = compareBuckets(buckets([1, 3, 4, 2]), buckets([0, 2, 4, 4]));
    assert.equal(c.significant, false, `score ${c.score}`);
});

test('correlated samples from few logs stay within noise', () => {
    // Same shift as above, but all samples come from 8 logs per version.
    const c = compareBuckets(
        buckets([100, 300, 400, 200]),
        buckets([20, 150, 430, 400]),
        8,
        8,
    );

    assert.equal(c.significant, false, `score ${c.score}`);
});

test('defaults to the busiest channel and its two newest versions', () => {
    const usage = [
        { version: '156.0.1.1', channel: 'stable', logs: 500 },
        { version: '157.0.1.1', channel: 'stable', logs: 900 },
        { version: '157.0.2.1', channel: 'stable', logs: 300 },
        { version: '158.0.1.1', channel: 'beta', logs: 200 },
    ];

    const all = chooseVersions(usage, undefined, () => true);
    assert.equal(all.channel, 'stable');
    assert.deepEqual(all.pair, ['157.0.1.1', '157.0.2.1']);

    const beta = chooseVersions(usage, 'beta', () => true);
    assert.equal(beta.pair, null);

    const eligible = chooseVersions(
        usage,
        undefined,
        (v) => v !== '157.0.2.1',
    );

    assert.deepEqual(eligible.pair, ['156.0.1.1', '157.0.1.1']);
});

test('measures platform mix differences', () => {
    const a = new Map([['macOS', 50], ['Windows', 50]]);
    assert.equal(mixShift(a, new Map([['macOS', 5], ['Windows', 5]])), 0);
    assert.equal(mixShift(a, new Map([['macOS', 100]])), 0.5);
});

async function seedTwoVersions(t: Awaited<ReturnType<typeof setup>>) {
    const now = Date.now();
    let id = 1n;

    const versions = [
        { version: '1.0.0.0', fcpMin: 100 },
        { version: '1.0.1.0', fcpMin: 400 },
    ];

    for (const { version, fcpMin } of versions) {
        for (let i = 0; i < 40; i++) {
            const log = encodeLog({
                clientId: id++,
                version,
                histograms: [
                    {
                        hash: FCP,
                        buckets: [{
                            min: fcpMin,
                            max: fcpMin + 100,
                            count: 6,
                        }],
                    },
                    {
                        hash: MEMORY,
                        buckets: [{ min: 300, max: 400, count: 6 }],
                    },
                ],
            });

            await ingestLog(await umaRequest(log), t.db, 1 << 20, { now });
        }
    }
}

test('changes page ranks what moved and skips what did not', async () => {
    await using t = await setup();
    await seedTwoVersions(t);

    const html = await (await t.app.request('/changes')).text();
    assert.ok(html.includes('<option selected>1.0.0.0</option>'));
    assert.ok(html.includes('<option selected>1.0.1.0</option>'));
    assert.ok(html.includes('/h/8559fe6630fce9a7'));
    assert.ok(!html.includes('/h/3bcbd964bd863ac3'));
});

test('pins histograms and shows them on the overview', async () => {
    await using t = await setup();
    await seedTwoVersions(t);
    const origin = t.config.publicBaseUrl;
    const form = { 'content-type': 'application/x-www-form-urlencoded' };

    const foreign = await t.app.request('/h/8559fe6630fce9a7/pin', {
        method: 'POST',
        headers: { ...form, origin: 'https://evil.example' },
    });

    assert.equal(foreign.status, 403);
    assert.equal(t.db.isPinned(FCP), false);

    const res = await t.app.request('/h/8559fe6630fce9a7/pin?days=30', {
        method: 'POST',
        headers: { ...form, origin },
    });

    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/h/8559fe6630fce9a7?days=30');
    assert.equal(t.db.isPinned(FCP), true);

    const overview = await (await t.app.request('/')).text();
    assert.ok(overview.includes('<h2>Pinned</h2>'));
    assert.ok(overview.includes('/h/8559fe6630fce9a7'));

    await t.app.request('/h/8559fe6630fce9a7/unpin', {
        method: 'POST',
        headers: { ...form, origin },
    });
    assert.equal(t.db.isPinned(FCP), false);
});
