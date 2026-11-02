import { assert, assertEquals } from '@std/assert';
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

const reconnect = async (url: string, uaid: string, channels: string[]) => {
    const ua = await FakeUA.connect(url);
    await ua.hello(uaid, channels);
    return ua;
};

Deno.test('redelivers unacked messages on reconnect', async () => {
    const node = await startNode();
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();

        await push(endpoint, 'one');
        await push(endpoint, 'two');
        const one = await ua.notification();
        const two = await ua.notification();
        ua.ack(one);
        await ua.close();

        ua = await reconnect(node.wsUrl, uaid, [channelID]);
        const again = await ua.notification();
        assertEquals(again.version, two.version);
        assertEquals(text(again.data), 'two');
        await ua.none((m) => m.messageType === 'notification');
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('does not redeliver acked, nacked or deleted messages', async () => {
    const node = await startNode();
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();

        await push(endpoint, 'acked');
        await push(endpoint, 'nacked');
        ua.ack(await ua.notification());
        const nacked = await ua.notification();
        ua.send({ messageType: 'nack', version: nacked.version, code: 301 });
        await ua.close();

        const res = await push(endpoint, 'deleted');
        const del = await fetch(res.headers.get('location')!, {
            method: 'DELETE',
        });
        assertEquals(del.status, 204);

        ua = await reconnect(node.wsUrl, uaid, [channelID]);
        await ua.none((m) => m.messageType === 'notification');
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('holds messages until the client registers their channel', async () => {
    const node = await startNode();
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const listed = await ua.register();
        const later = await ua.register();
        await ua.close();

        await push(later.endpoint, 'later');
        await push(listed.endpoint, 'listed');

        ua = await reconnect(node.wsUrl, uaid, [listed.channelID]);
        assertEquals(text((await ua.notification()).data), 'listed');
        await ua.none((m) => m.messageType === 'notification');

        await ua.register(later.channelID);
        assertEquals(text((await ua.notification()).data), 'later');
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('delivers to clients which register channels after hello', async () => {
    const node = await startNode();
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();
        await ua.close();

        await push(endpoint, 'x');

        ua = await FakeUA.connect(node.wsUrl);
        assertEquals(await ua.hello(uaid), uaid);
        await ua.register(channelID);
        assertEquals(text((await ua.notification()).data), 'x');
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('keeps delivering to the newest connection of a client', async () => {
    const node = await startNode();
    const old = await FakeUA.connect(node.wsUrl);
    let ua: FakeUA | undefined;
    try {
        const uaid = await old.hello();
        ua = await FakeUA.connect(node.wsUrl);
        assertEquals(await ua.hello(uaid), uaid);
        const { endpoint } = await ua.register();

        // It's being closed, but might still get a register through.
        old.send({ messageType: 'register', channelID: crypto.randomUUID() });
        await push(endpoint, 'x');
        assertEquals(text((await ua.notification()).data), 'x');
    } finally {
        await old.close();
        await ua?.close();
        await node.stop();
    }
});

Deno.test('rejects pushes once a channel queue is full', async () => {
    const node = await startNode({ MINIPUSH_MAX_QUEUED_PER_CHANNEL: '2' });
    const ua = await FakeUA.connect(node.wsUrl);
    try {
        await ua.hello();
        const { endpoint } = await ua.register();
        const other = await ua.register();
        await ua.close();

        assertEquals((await push(endpoint, '1')).status, 201);
        assertEquals((await push(endpoint, '2')).status, 201);
        assertEquals((await push(endpoint, '3')).status, 429);

        // a full channel doesn't affect other channels of the same ua
        assertEquals((await push(other.endpoint, '1')).status, 201);
        assertEquals((await push(other.endpoint, '2')).status, 201);
    } finally {
        await node.stop();
    }
});

Deno.test('forgets messages of unregistered channels', async () => {
    const node = await startNode();
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();

        await push(endpoint, 'x');
        await ua.notification();
        ua.send({ messageType: 'unregister', channelID });
        await ua.next((m) => m.messageType === 'unregister');
        await ua.close();

        // even if the ua comes back claiming to have the channel
        ua = await reconnect(node.wsUrl, uaid, [channelID]);
        await ua.none((m) => m.messageType === 'notification');
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('does not redeliver expired messages', async () => {
    const node = await startNode();
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();
        await ua.close();

        assertEquals((await push(endpoint, 'x', { ttl: '1' })).status, 201);
        await new Promise((r) => setTimeout(r, 1100));

        ua = await reconnect(node.wsUrl, uaid, [channelID]);
        await ua.none((m) => m.messageType === 'notification');
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('closes connections which do not ack in time', async () => {
    const node = await startNode({ MINIPUSH_ACK_TIMEOUT_MS: '500' });
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();

        await push(endpoint, 'x');
        const n = await ua.notification();
        assertEquals((await ua.closed).code, 3008);

        ua = await reconnect(node.wsUrl, uaid, [channelID]);
        assertEquals((await ua.notification()).version, n.version);
        ua.ack(n);
        await ua.none(undefined, 1000);
        assertEquals(ua.ws.readyState, WebSocket.OPEN);
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('holds back messages until the client catches up', async () => {
    const node = await startNode({
        MINIPUSH_MAX_QUEUED_PER_CHANNEL: '1000',
        MINIPUSH_RATE_LIMIT_PER_CHANNEL: '1000',
    });
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();
        await ua.close();

        // about twice as much as the server buffers per connection
        const total = 400;
        for (let i = 0; i < total; i++) {
            assertEquals((await push(endpoint, 'x'.repeat(4000))).status, 201);
        }

        ua = await reconnect(node.wsUrl, uaid, [channelID]);
        const receiveAll = async () => {
            const received = [];
            try {
                while (true) {
                    received.push(await ua.notification(500));
                }
            } catch (e) {
                if (
                    !(e instanceof Error) || !e.message.startsWith('timed out')
                ) {
                    throw e;
                }
            }
            return received;
        };

        let received = await receiveAll();
        assert(received.length < total, `got all ${total} without acking`);

        let count = 0;
        while (received.length > 0) {
            count += received.length;
            ua.ack(...received);
            received = await receiveAll();
        }
        assertEquals(count, total);
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('keeps delivering after unregistering a held back channel', async () => {
    const node = await startNode({
        MINIPUSH_MAX_QUEUED_PER_CHANNEL: '1000',
        MINIPUSH_RATE_LIMIT_PER_CHANNEL: '1000',
    });
    let ua = await FakeUA.connect(node.wsUrl);
    try {
        const uaid = await ua.hello();
        const a = await ua.register();
        const b = await ua.register();
        await ua.close();

        for (let i = 0; i < 400; i++) {
            assertEquals(
                (await push(a.endpoint, 'x'.repeat(4000))).status,
                201,
            );
        }
        await push(b.endpoint, 'b');

        ua = await reconnect(node.wsUrl, uaid, [a.channelID, b.channelID]);
        await ua.notification();
        ua.send({ messageType: 'unregister', channelID: a.channelID });

        const n = await ua.next((m) =>
            m.messageType === 'notification' && m.channelID === b.channelID
        );
        assertEquals(text(n.data), 'b');
    } finally {
        await ua.close();
        await node.stop();
    }
});
