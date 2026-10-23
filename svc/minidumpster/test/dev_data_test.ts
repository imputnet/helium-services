import { assertEquals } from '@std/assert';

import { seedDevData } from '../src/dev-seed.ts';
import { processedPath } from '../src/paths.ts';
import { makeTestEnv } from './helpers.ts';

Deno.test('dev data seeds realistic reports idempotently', async () => {
    const env = await makeTestEnv();
    try {
        const now = Date.UTC(2026, 6, 24, 12);
        const first = await seedDevData(env.db, env.config, now);
        const second = await seedDevData(env.db, env.config, now);

        assertEquals(first, { reportsCreated: 8, reportsTotal: 8 });
        assertEquals(second, { reportsCreated: 0, reportsTotal: 8 });
        assertEquals(
            env.db.listGroups().map((group) => group.report_count),
            [3, 2, 1, 1],
        );

        const processed = env.db.getReport(
            '10000000-0000-4000-8000-000000000001',
        )!;
        assertEquals(processed.status, 'processed');
        assertEquals(processed.kind, 'apple');
        assertEquals(processed.platform, 'macOS');
        await Deno.stat(processedPath(env.dir, processed.id));

        const unsymbolicated = env.db.getReport(
            '30000000-0000-4000-8000-000000000001',
        )!;
        assertEquals(unsymbolicated.symbolicated, 0);

        const machinery = env.db.getReport(
            '50000000-0000-4000-8000-000000000001',
        )!;
        assertEquals(machinery.ptype, 'renderer');

        const pending = env.db.getReport(
            '40000000-0000-4000-8000-000000000001',
        )!;
        assertEquals(pending.status, 'pending');
        assertEquals(env.db.listArtifactIngests().length, 2);
    } finally {
        await env.cleanup();
    }
});
