import { assertEquals } from '@std/assert';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { Ring } from '../lib/mesh/ring.ts';
import {
    FakeUA,
    type Node,
    push,
    restartNode,
    startCluster,
} from './helpers.ts';

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

// Pushes via `node` until the UA gets it, since it might take a moment
// for the mesh to settle after members come or go.
const pushUntilDelivered = async (
    ua: FakeUA,
    endpoint: string,
    node: Node,
    body: string,
) => {
    for (let attempt = 0; attempt < 10; attempt++) {
        const res = await push(endpoint, body);
        assertEquals(res.status, 201, `push via ${node.id}`);
        try {
            const n = await ua.notification(500);
            assertEquals(text(n.data), body);
            ua.ack(n);
            return;
        } catch {
            // not yet
        }
    }

    throw new Error(`push via ${node.id} never arrived`);
};

// The UAID which the home members are picked by.
const internalUaid = (uaid: string) =>
    encodeBase64Url(decodeBase64Url(uaid).subarray(0, 12));

Deno.test('keeps delivering while home members restart', async () => {
    const nodes = await startCluster(['a', 'b', 'c']);
    const byId = (id: string) => nodes.find((n) => n.id === id)!;
    let ua = await FakeUA.connect(nodes[0].wsUrl);
    try {
        const uaid = await ua.hello();
        const { channelID, endpoint } = await ua.register();
        await ua.close();

        // Connect to the member which is least preferred as a home, so
        // that both homes are elsewhere.
        const [primary, secondary, edge] = new Ring(['a', 'b', 'c'])
            .rank(internalUaid(uaid))
            .map(byId);

        ua = await FakeUA.connect(edge.wsUrl);
        await ua.hello(uaid, [channelID]);
        const to = (node: Node) => via(endpoint, nodes[0], node);

        // The primary home comes back without knowing where the UA is,
        // until the edge tells it again.
        await primary.stop();
        nodes[nodes.indexOf(primary)] = await restartNode(primary);
        const restarted = byId(primary.id);
        await pushUntilDelivered(ua, to(restarted), restarted, 'restarted');

        // With the primary home gone, the others take over.
        await restarted.stop();
        await pushUntilDelivered(ua, to(secondary), secondary, 'via secondary');
        await pushUntilDelivered(ua, to(edge), edge, 'via edge');
    } finally {
        await ua.close();
        await stopAll(nodes);
    }
});
