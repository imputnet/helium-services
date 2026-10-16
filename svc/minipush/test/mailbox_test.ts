import { assertEquals } from '@std/assert';
import { Expiry } from '../lib/home/expiry.ts';
import { Mailbox, type StoredMessage } from '../lib/home/mailbox.ts';

const T0 = 1_000_000_000;

Deno.test('expiry yields items once they are due', () => {
    const wheel = new Expiry<string>(T0);
    wheel.add('a', T0 + 1500);
    wheel.add('b', T0 + 3000);
    wheel.add('c', T0 + 3000);
    wheel.add('gone', T0 + 3000);
    wheel.delete('gone', T0 + 3000);
    assertEquals(wheel.size, 3);

    assertEquals([...wheel.due(T0 + 1000)], []);
    assertEquals([...wheel.due(T0 + 2000)], ['a']);
    assertEquals([...wheel.due(T0 + 2999)], []);
    assertEquals([...wheel.due(T0 + 60_000)], ['b', 'c']);
    assertEquals(wheel.size, 0);
});

Deno.test('expiry never loses items scheduled in the past', () => {
    const wheel = new Expiry<string>(T0);
    [...wheel.due(T0 + 5000)];
    wheel.add('late', T0);
    assertEquals([...wheel.due(T0 + 6000)], ['late']);
});

let n = 0;
const message = (
    uaid: string,
    channelID = 'chan',
    expiresAt = T0 + 10_000,
    data = 'x'.repeat(100),
): StoredMessage => ({
    uaid,
    expiresAt,
    data: {
        messageType: 'notification',
        channelID,
        version: `v${n++}`,
        data,
        headers: { ttl: '10' },
    },
});

const limits = { perChannel: 2, maxBytes: 10_000 };

Deno.test('mailbox limits each channel on its own', () => {
    const box = new Mailbox(limits, T0);
    assertEquals(box.add(message('u', 'a')), 'ok');
    const second = message('u', 'a');
    assertEquals(box.add(second), 'ok');
    assertEquals(box.add(message('u', 'a')), 'full');

    // other channels, of the same UA or not, are unaffected
    assertEquals(box.add(message('u', 'b')), 'ok');
    assertEquals(box.add(message('u', 'c')), 'ok');
    assertEquals(box.add(message('other', 'a')), 'ok');
    assertEquals(box.count, 5);

    // and the channel has room again once a message is gone
    box.remove('u', second.data.version);
    assertEquals(box.add(message('u', 'a')), 'ok');
});

Deno.test('mailbox enforces the byte budget', () => {
    const box = new Mailbox({ ...limits, maxBytes: 1000 }, T0);
    assertEquals(box.add(message('a', 'c', T0 + 1000, 'x'.repeat(400))), 'ok');
    assertEquals(
        box.add(message('b', 'c', T0 + 1000, 'x'.repeat(400))),
        'over-budget',
    );

    box.expire(T0 + 1000);
    assertEquals(box.bytes, 0);
    assertEquals(box.add(message('b', 'c', T0 + 1000, 'x'.repeat(400))), 'ok');
});

Deno.test('mailbox removes and expires messages', () => {
    const box = new Mailbox(limits, T0);
    const a = message('u', 'a', T0 + 1000);
    const b = message('u', 'b', T0 + 5000);
    const c = message('w', 'a', T0 + 1000);
    box.add(a);
    box.add(b);
    box.add(c);

    assertEquals(box.get('u', T0), [a, b]);
    assertEquals(box.remove('u', a.data.version), true);
    assertEquals(box.remove('u', a.data.version), false);
    assertEquals(box.get('u', T0), [b]);

    assertEquals(box.expire(T0 + 1000), 1);
    assertEquals(box.get('w', T0), []);
    assertEquals([...box.uaids()], ['u']);

    box.remove('u', b.data.version);
    assertEquals(box.count, 0);
    assertEquals(box.bytes, 0);
    assertEquals(box.expire(T0 + 60_000), 0);
});

Deno.test('mailbox hides expired messages before they are dropped', () => {
    const box = new Mailbox(limits, T0);
    const a = message('u', 'a', T0 + 1000);
    const b = message('u', 'b', T0 + 5000);
    box.add(a);
    box.add(b);

    assertEquals(box.get('u', T0 + 999), [a, b]);
    assertEquals(box.get('u', T0 + 1000), [b]);
    assertEquals(box.count, 2);
});

Deno.test('mailbox removes all messages of a channel', () => {
    const box = new Mailbox(limits, T0);
    const a = message('u', 'a');
    const b = message('u', 'b');
    box.add(a);
    box.add(message('u', 'a'));
    box.add(b);

    box.removeChannel('u', 'a');
    assertEquals(box.get('u', T0), [b]);
    assertEquals(box.count, 1);

    // and the channel's quota is free again
    assertEquals(box.add(message('u', 'a')), 'ok');
    assertEquals(box.add(message('u', 'a')), 'ok');
});
