import { assertEquals } from '@std/assert';
import { decodeBase64Url } from '@std/encoding/base64url';
import { FakeUA, push, startNode } from './helpers.ts';

const text = (b64: string) => new TextDecoder().decode(decodeBase64Url(b64));

Deno.test('delivers a push to a connected client', async () => {
    const node = await startNode();
    const ua = await FakeUA.connect(node.wsUrl);
    try {
        await ua.hello();
        const { channelID, endpoint } = await ua.register();

        const res = await push(endpoint, 'hello');
        assertEquals(res.status, 201);

        const n = await ua.notification();
        assertEquals(n.channelID, channelID);
        assertEquals(text(n.data), 'hello');
        assertEquals(n.headers.encoding, 'aes128gcm');
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('queues pushes for a disconnected client', async () => {
    const node = await startNode();
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();
        await ua.close();

        assertEquals((await push(endpoint, 'queued')).status, 201);

        ua = await FakeUA.connect(node.wsUrl);
        assertEquals(await ua.hello(uaid, [channelID]), uaid);

        const n = await ua.notification();
        assertEquals(text(n.data), 'queued');
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('rejects pushes to forged endpoints', async () => {
    const node = await startNode();
    try {
        const res = await push(`${node.url}wpush/v1/AAAA`, 'nope');
        assertEquals(res.status, 400);
    } finally {
        await node.stop();
    }
});
