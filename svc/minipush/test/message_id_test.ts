import './unit_env.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Buf from '../lib/util/buffer.ts';
import * as MessageId from '../lib/webpush/message-id.ts';
import * as UAID from '../lib/ua/uaid.ts';
import { FakeUA, push, startNode } from './helpers.ts';

test('message ids round-trip the uaid', async () => {
    const uaid = await UAID.unwrap(await UAID.generate());
    const a = await MessageId.make(uaid);
    const b = await MessageId.make(uaid);

    assert.notEqual(a, b);
    assert.equal(await MessageId.unwrap(a), uaid);
    assert.equal(await MessageId.unwrap(b), uaid);
});

test('tampered message ids are rejected', async () => {
    const uaid = await UAID.unwrap(await UAID.generate());
    const bytes = Buf.fromBase64Url(await MessageId.make(uaid));
    bytes[bytes.length - 1] ^= 1;

    await assert.rejects(() => MessageId.unwrap(Buf.toBase64Url(bytes)));
    await assert.rejects(() => MessageId.unwrap('AAAA'));
});

test('message location matches version and can be deleted', async () => {
    const node = await startNode();
    const ua = await FakeUA.connect(node.wsUrl);
    try {
        await ua.hello();
        const { endpoint } = await ua.register();

        const res = await push(endpoint, 'x');
        const location = res.headers.get('location')!;
        const n = await ua.notification();
        assert.equal(location, `${node.url}m/${n.version}`);

        const del = await fetch(location, { method: 'DELETE' });
        assert.equal(del.status, 204);

        const bogus = await fetch(`${node.url}m/AAAA`, { method: 'DELETE' });
        assert.equal(bogus.status, 404);
    } finally {
        await ua.close();
        await node.stop();
    }
});
