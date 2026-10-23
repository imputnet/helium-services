import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stat } from 'node:fs/promises';

import { seedDevData } from '../src/dev-seed.ts';
import { processedPath } from '../src/paths.ts';
import { makeTestEnv } from './helpers.ts';

test('dev data seeds realistic reports idempotently', async () => {
    const env = await makeTestEnv();
    try {
        const now = Date.UTC(2026, 6, 24, 12);
        const first = await seedDevData(env.db, env.config, now);
        const second = await seedDevData(env.db, env.config, now);

        assert.deepStrictEqual(first, { reportsCreated: 8, reportsTotal: 8 });
        assert.deepStrictEqual(second, { reportsCreated: 0, reportsTotal: 8 });
        assert.deepStrictEqual(
            env.db.listGroups().map((group) => group.report_count),
            [3, 2, 1, 1],
        );

        const processed = env.db.getReport(
            '10000000-0000-4000-8000-000000000001',
        )!;
        assert.equal(processed.status, 'processed');
        assert.equal(processed.kind, 'apple');
        assert.equal(processed.platform, 'macOS');
        await stat(processedPath(env.dir, processed.id));

        const unsymbolicated = env.db.getReport(
            '30000000-0000-4000-8000-000000000001',
        )!;
        assert.equal(unsymbolicated.symbolicated, 0);

        const machinery = env.db.getReport(
            '50000000-0000-4000-8000-000000000001',
        )!;
        assert.equal(machinery.ptype, 'renderer');

        const pending = env.db.getReport(
            '40000000-0000-4000-8000-000000000001',
        )!;
        assert.equal(pending.status, 'pending');
        assert.equal(env.db.listArtifactIngests().length, 2);
    } finally {
        await env.cleanup();
    }
});
