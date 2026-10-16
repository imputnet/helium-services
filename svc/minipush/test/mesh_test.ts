import { assertEquals } from '@std/assert';
import { decodeBase64Url } from '@std/encoding/base64url';
import { FakeUA, type Node, push, startCluster } from './helpers.ts';

const text = (b64: string) => new TextDecoder().decode(decodeBase64Url(b64));

// Endpoints point at whichever member the UA registered on, but anycast
// means that pushes may land on any member.
const via = (endpoint: string, from: Node, to: Node) =>
    endpoint.replace(from.url, to.url);

const stopAll = (nodes: Node[]) => Promise.all(nodes.map((n) => n.stop()));

Deno.test('delivers pushes received by other members', async () => {
    const nodes = await startCluster(['a', 'b', 'c']);
    const [a, b, c] = nodes;
    let ua = await FakeUA.connect(a.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();

        for (const node of nodes) {
            const res = await push(via(endpoint, a, node), node.id);
            assertEquals(res.status, 201);
            assertEquals(text((await ua.notification()).data), node.id);
        }

        // deleting works from anywhere too
        await ua.close();
        const res = await push(via(endpoint, a, b), 'deleted');
        const location = res.headers.get('location')!;
        const del = await fetch(via(location, a, c), { method: 'DELETE' });
        assertEquals(del.status, 204);

        ua = await FakeUA.connect(c.wsUrl);
        await ua.hello(uaid, [channelID]);
        const redelivered = [];
        while (true) {
            try {
                redelivered.push(text((await ua.notification(500)).data));
            } catch {
                break;
            }
        }

        // nothing was acked, so everything but the deleted one comes back
        assertEquals(redelivered.sort(), ['a', 'b', 'c']);
    } finally {
        await ua.close();
        await stopAll(nodes);
    }
});

Deno.test('acks are forwarded to the member storing the message', async () => {
    const nodes = await startCluster(['a', 'b', 'c']);
    const [a, b, c] = nodes;
    let ua = await FakeUA.connect(a.wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();

        for (const node of nodes) {
            await push(via(endpoint, a, node), node.id);
            ua.ack(await ua.notification());
        }

        await push(via(endpoint, a, b), 'unacked');
        await ua.notification();
        await ua.close();

        ua = await FakeUA.connect(c.wsUrl);
        await ua.hello(uaid, [channelID]);
        assertEquals(text((await ua.notification()).data), 'unacked');
        await ua.none((m) => m.messageType === 'notification', 500);
    } finally {
        await ua.close();
        await stopAll(nodes);
    }
});

Deno.test('members with the wrong mesh secret are not let in', async () => {
    const nodes = await startCluster(['a', 'b'], {}, {
        b: { MINIPUSH_MESH_SECRET: 'wrong' },
    });
    const [a, b] = nodes;
    const ua = await FakeUA.connect(a.wsUrl);
    try {
        await ua.hello();
        const { endpoint } = await ua.register();
        await push(via(endpoint, a, b), 'x');
        await ua.none((m) => m.messageType === 'notification', 500);
    } finally {
        await ua.close();
        await stopAll(nodes);
    }
});
