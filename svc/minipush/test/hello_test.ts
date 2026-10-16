import { assertEquals, assertNotEquals } from '@std/assert';
import { FakeUA, push, startNode } from './helpers.ts';

Deno.test('hello with an unknown uaid hands out a new one', async () => {
    const node = await startNode();
    const ua = await FakeUA.connect(node.wsUrl);
    try {
        const forged =
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const uaid = await ua.hello(forged, [crypto.randomUUID()]);
        assertNotEquals(uaid, forged);

        const { endpoint } = await ua.register();
        assertEquals((await push(endpoint, 'x')).status, 201);
        await ua.notification();
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('a new connection supersedes the previous one', async () => {
    const node = await startNode();
    const first = await FakeUA.connect(node.wsUrl);
    const second = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await first.hello();
        const { channelID, endpoint } = await first.register();

        await second.hello(uaid, [channelID]);
        assertEquals((await first.closed).code, 1001);

        await push(endpoint, 'x');
        await second.notification();
    } finally {
        await first.close();
        await second.close();
        await node.stop();
    }
});
