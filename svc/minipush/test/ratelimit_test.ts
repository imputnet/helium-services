import { assertEquals } from '@std/assert';
import { FakeUA, push, startNode } from './helpers.ts';

Deno.test('rate limits pushes per channel', async () => {
    const node = await startNode({ MINIPUSH_RATE_LIMIT_PER_CHANNEL: '2' });
    const ua = await FakeUA.connect(node.wsUrl);
    const other = await FakeUA.connect(node.wsUrl);
    try {
        await ua.hello();
        await other.hello();
        const a = await ua.register();
        const b = await ua.register();
        // same channel id, but another ua
        const c = await other.register(a.channelID);

        assertEquals((await push(a.endpoint)).status, 201);
        assertEquals((await push(a.endpoint)).status, 201);
        assertEquals((await push(a.endpoint)).status, 429);
        assertEquals((await push(b.endpoint)).status, 201);
        assertEquals((await push(c.endpoint)).status, 201);
    } finally {
        await ua.close();
        await other.close();
        await node.stop();
    }
});

Deno.test('rate limits connections per client ip', async () => {
    const node = await startNode({
        MINIPUSH_RATE_LIMIT_CONNECTS_PER_IP: '2',
        MINIPUSH_TRUST_PROXY: '1',
    });

    const connect = async (ip: string) => {
        const res = await fetch(node.url, {
            headers: { 'x-forwarded-for': `198.51.100.1, ${ip}` },
        });
        await res.body?.cancel();
        return res.status;
    };

    try {
        // not a websocket upgrade, but still counts towards the limit
        assertEquals(await connect('192.0.2.1'), 426);
        assertEquals(await connect('192.0.2.1'), 426);
        assertEquals(await connect('192.0.2.1'), 429);
        assertEquals(await connect('192.0.2.2'), 426);
    } finally {
        await node.stop();
    }
});
