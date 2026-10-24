import './unit_env.ts';
import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import * as MessageId from '../lib/webpush/message-id.ts';
import * as UAID from '../lib/ua/uaid.ts';
import { FakeUA, push, startNode } from './helpers.ts';

Deno.test('message ids round-trip the uaid', async () => {
    const uaid = await UAID.unwrap(await UAID.generate());
    const a = await MessageId.make(uaid);
    const b = await MessageId.make(uaid);

    assertNotEquals(a, b);
    assertEquals(await MessageId.unwrap(a), uaid);
    assertEquals(await MessageId.unwrap(b), uaid);
});

Deno.test('tampered message ids are rejected', async () => {
    const uaid = await UAID.unwrap(await UAID.generate());
    const bytes = decodeBase64Url(await MessageId.make(uaid));
    bytes[bytes.length - 1] ^= 1;

    await assertRejects(() => MessageId.unwrap(encodeBase64Url(bytes)));
    await assertRejects(() => MessageId.unwrap('AAAA'));
});

Deno.test('message location matches version and can be deleted', async () => {
    const node = await startNode();
    const ua = await FakeUA.connect(node.wsUrl);
    try {
        await ua.hello();
        const { endpoint } = await ua.register();

        const res = await push(endpoint, 'x');
        const location = res.headers.get('location')!;
        const n = await ua.notification();
        assertEquals(location, `${node.url}m/${n.version}`);

        const del = await fetch(location, { method: 'DELETE' });
        assertEquals(del.status, 204);

        const bogus = await fetch(`${node.url}m/AAAA`, { method: 'DELETE' });
        assertEquals(bogus.status, 404);
    } finally {
        await ua.close();
        await node.stop();
    }
});
