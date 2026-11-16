import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseUmaLog, resolveBuckets } from '../src/uma.ts';
import { ProtoError } from '../src/proto.ts';
import { hashMetricName, hashToHex } from '../src/names.ts';
import { percentile } from '../src/stats.ts';
import { encodeLog, FCP, MEMORY } from './helpers.ts';

test('hashMetricName matches base::HashMetricName', async () => {
    assert.deepEqual(
        hashToHex(
            await hashMetricName('Memory.Browser.PrivateMemoryFootprint'),
        ),
        hashToHex(MEMORY),
    );
    assert.deepEqual(
        await hashMetricName(
            'PageLoad.PaintTiming.NavigationToFirstContentfulPaint',
        ),
        FCP,
    );
});

test('parses the kept fields and drops the rest', () => {
    const log = parseUmaLog(encodeLog({
        clientId: 0xfedcba9876543210n,
        version: '142.0.7444.1-64',
        channel: 4,
        os: 'Mac OS X',
        arch: 'arm64',
        histograms: [{
            hash: FCP,
            sum: 1234,
            buckets: [{ min: 100, max: 200, count: 3 }, { min: 200, max: 400 }],
        }],
    }));

    assert.deepEqual(log, {
        clientId: 0xfedcba9876543210n,
        product: 0,
        version: '142.0.7444.1-64',
        channel: 'stable',
        os: 'macOS',
        arch: 'arm64',
        histograms: [{
            hash: FCP,
            sum: 1234,
            buckets: [
                { min: 100, max: 200, count: 3 },
                { min: 200, max: 400, count: 1 },
            ],
        }],
    });
});

test('resolves omitted bucket bounds like Chromium', () => {
    // Enum buckets omit min (= max - 1); contiguous buckets omit max (= next
    // bucket's min); count defaults to 1.
    assert.deepEqual(
        resolveBuckets([
            { max: 1, count: 5 },
            { max: 2, count: 1 },
            { min: 10, count: 2 },
            { min: 20, max: 30, count: 4 },
        ]),
        [
            { min: 0, max: 1, count: 5 },
            { min: 1, max: 2, count: 1 },
            { min: 10, max: 20, count: 2 },
            { min: 20, max: 30, count: 4 },
        ],
    );
});

test('handles negative sparse histogram values', () => {
    const log = parseUmaLog(encodeLog({
        histograms: [{
            hash: MEMORY,
            buckets: [{ min: -5, max: -4, count: 2 }],
        }],
    }));

    assert.deepEqual(log.histograms[0].buckets, [{
        min: -5,
        max: -4,
        count: 2,
    }]);
});

test('normalizes untrusted dimensions', () => {
    const log = parseUmaLog(encodeLog({
        version: '<script>',
        os: 'TempleOS',
        arch: 'riscv',
        channel: 99,
    }));

    assert.deepEqual(
        [log.version, log.os, log.arch, log.channel],
        ['unknown', 'other', 'other', 'unknown'],
    );
});

test('rejects malformed logs', () => {
    assert.throws(
        () => parseUmaLog(new Uint8Array([0x0a, 0x05, 1])),
        ProtoError,
    );
    assert.throws(
        () => resolveBuckets([{ min: 5, count: 1 }]),
        (e) => e instanceof ProtoError && e.message.includes('missing max'),
    );
    assert.throws(
        () =>
            parseUmaLog(encodeLog({
                histograms: [{ hash: FCP, buckets: [{ count: 1 }] }],
            })),
        ProtoError,
    );
});

test('percentiles interpolate within buckets', () => {
    const buckets = [
        { min: 0, max: 10, count: 50 },
        { min: 10, max: 20, count: 50 },
    ];

    assert.deepEqual(percentile(buckets, 0.5), 10);
    assert.deepEqual(percentile(buckets, 0.75), 15);
    assert.deepEqual(percentile([{ min: 3, max: 4, count: 9 }], 0.5), 3);
    assert.deepEqual(percentile([], 0.5), null);
});
