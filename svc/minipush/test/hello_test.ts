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

Deno.test('caps the number of channels per uaid', async () => {
    const node = await startNode({ MINIPUSH_MAX_CHANNELS_PER_UAID: '2' });
    const ua = await FakeUA.connect(node.wsUrl);
    try {
        await ua.hello();
        const { channelID } = await ua.register();
        await ua.register();
        await ua.register(channelID);

        ua.send({ messageType: 'register', channelID: crypto.randomUUID() });
        const res = await ua.next((m) => m.messageType === 'register');
        assertEquals(res.status, 413);
        assertEquals(res.pushEndpoint, undefined);
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('reissues uaids which come back with too many channels', async () => {
    const node = await startNode({ MINIPUSH_MAX_CHANNELS_PER_UAID: '2' });
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        await ua.close();

        ua = await FakeUA.connect(node.wsUrl);
        const channels = [1, 2, 3].map(() => crypto.randomUUID());
        assertNotEquals(await ua.hello(uaid, channels), uaid);
    } finally {
        await ua.close();
        await node.stop();
    }
});
