import { assert, assertEquals } from '@std/assert';
import { buildApp } from '../src/app.ts';
import { makeTestEnv, testSessionCookie } from './helpers.ts';

Deno.test('daily charts aggregate breakdowns, filters, and entire groups', async () => {
    const env = await makeTestEnv();
    try {
        const today = Date.parse(new Date().toISOString().slice(0, 10));
        const day = new Date(today).toISOString().slice(0, 10);
        const groupId = env.db.upsertGroup('chart-group', 'Chart crash', today);
        const otherId = env.db.upsertGroup('other-group', 'Other crash', today);
        const add = (
            version: string | null,
            platform: string | null,
            group: number | null,
            receivedAt = today,
            product = 'Helium',
        ) => {
            const id = crypto.randomUUID();
            env.db.insertReport({
                id,
                product,
                version,
                guid: null,
                ptype: 'browser',
                channel: null,
                annotations: '{}',
                received_at: receivedAt,
            });
            if (group !== null) {
                env.db.markProcessed(id, group, platform, today, true, 1);
            }
        };
        // Exceeds the recent-reports page limit of 50.
        for (let i = 0; i < 51; i++) add('1.0', 'Linux', groupId);
        add('2.0', 'Windows', groupId);
        add('2.0', 'Windows', otherId, today, 'Other product');
        add(null, null, null);
        add('old', 'Linux', groupId, today - 14 * 86400_000);
        env.db.recountGroups([groupId, otherId]);

        assertEquals(env.db.reportsPerDay(today), [{
            day,
            n: 54,
            segment: null,
        }]);
        assertEquals(
            env.db.reportsPerDay(today, {
                groupId,
                breakdown: 'version',
            }),
            [{ day, n: 51, segment: '1.0' }, { day, n: 1, segment: '2.0' }],
        );
        assertEquals(
            env.db.reportsPerDay(today, {
                breakdown: 'platform',
                filter: {
                    product: 'Helium',
                    version: '2.0',
                    platform: 'Windows',
                    ptype: 'browser',
                },
            }),
            [{ day, n: 1, segment: 'Windows' }],
        );

        const app = buildApp({ config: env.config, db: env.db });
        const cookie = await testSessionCookie(env);
        const page = async (path: string) => {
            const response = await app.request(path, { headers: { cookie } });
            assertEquals(response.status, 200);
            return response.text();
        };
        const overview = await page(
            '/?breakdown=platform&product=Helium&version=2.0',
        );
        assert(overview.includes('(1 total, UTC)'));
        assert(overview.includes('Windows (1)'));
        assert(overview.includes('breakdown=platform'));
        assert(overview.includes('name="version" value="2.0"'));
        const group = await page(`/groups/${groupId}?breakdown=version`);
        assert(group.includes('(52 total, UTC)'));
        assert(group.includes('1.0 (51)'));
        assert(group.includes('2.0 (1)'));
        assert(!group.includes('old (1)'));
        assertEquals((group.match(/class="bar"/g) ?? []).length, 14);
        const unknown = await page('/?breakdown=platform');
        assert(unknown.includes('Unknown (1)'));
        const fallback = await page(`/groups/${groupId}?breakdown=invalid`);
        assert(fallback.includes('value="total" selected'));
        assert(fallback.includes('(52 total, UTC)'));
    } finally {
        await env.cleanup();
    }
});
