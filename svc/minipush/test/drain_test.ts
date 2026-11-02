import { assert, assertEquals } from '@std/assert';
import { FakeUA, push, startNode, waitFor } from './helpers.ts';

const healthy = async (url: string) => {
    const res = await fetch(`${url}healthcheck`);
    await res.body?.cancel();
    return res.status;
};

Deno.test('draining waits for in-flight acks before closing', async () => {
    const node = await startNode({
        MINIPUSH_ACK_GRACE_MS: '5000',
        MINIPUSH_DRAIN_SECONDS: '1',
    });
    const ua = await FakeUA.connect(node.wsUrl);
    try {
        await ua.hello();
        const { endpoint } = await ua.register();
        await push(endpoint, 'x');
        const n = await ua.notification();

        node.proc.kill('SIGTERM');
        await waitFor(async () => await healthy(node.url) === 503);

        assertEquals((await push(endpoint, 'late')).status, 503);
        const upgrade = await fetch(node.url, {
            headers: { upgrade: 'websocket' },
        });
        await upgrade.body?.cancel();
        assertEquals(upgrade.status, 503);

        ua.ack(n);
        assertEquals((await ua.closed).code, 1012);

        const status = await node.exited();
        assertEquals(status.code, 0);
        assert(!node.output().includes('undelivered'), node.output());
    } finally {
        await ua.close();
        await node.stop();
    }
});

Deno.test('draining gives up on unacked messages eventually', async () => {
    const node = await startNode({
        MINIPUSH_ACK_GRACE_MS: '200',
        MINIPUSH_DRAIN_SECONDS: '0',
    });
    const ua = await FakeUA.connect(node.wsUrl);
    try {
        await ua.hello();
        const { endpoint } = await ua.register();
        await push(endpoint, 'x');
        await ua.notification();

        node.proc.kill('SIGTERM');
        assertEquals((await ua.closed).code, 1012);

        const status = await node.exited();
        assertEquals(status.code, 0);
        assert(
            node.output().includes('exiting with 1 undelivered messages'),
            node.output(),
        );
    } finally {
        await ua.close();
        await node.stop();
    }
});
