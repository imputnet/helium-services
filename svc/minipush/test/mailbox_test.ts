import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Expiry } from '../lib/home/expiry.ts';
import { Mailbox, type StoredMessage } from '../lib/home/mailbox.ts';

const T0 = 1_000_000_000;

test('expiry yields items once they are due', () => {
    const wheel = new Expiry<string>(T0);
    wheel.add('a', T0 + 1500);
    wheel.add('b', T0 + 3000);
    wheel.add('c', T0 + 3000);
    wheel.add('gone', T0 + 3000);
    wheel.delete('gone', T0 + 3000);
    assert.equal(wheel.size, 3);

    assert.deepStrictEqual([...wheel.due(T0 + 1000)], []);
    assert.deepStrictEqual([...wheel.due(T0 + 2000)], ['a']);
    assert.deepStrictEqual([...wheel.due(T0 + 2999)], []);
    assert.deepStrictEqual([...wheel.due(T0 + 60_000)], ['b', 'c']);
    assert.equal(wheel.size, 0);
});

test('expiry never loses items scheduled in the past', () => {
    const wheel = new Expiry<string>(T0);
    [...wheel.due(T0 + 5000)];
    wheel.add('late', T0);
    assert.deepStrictEqual([...wheel.due(T0 + 6000)], ['late']);
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

test('mailbox limits each channel on its own', () => {
    const box = new Mailbox(limits, T0);
    assert.equal(box.add(message('u', 'a')), 'ok');
    const second = message('u', 'a');
    assert.equal(box.add(second), 'ok');
    assert.equal(box.add(message('u', 'a')), 'full');

    // other channels, of the same UA or not, are unaffected
    assert.equal(box.add(message('u', 'b')), 'ok');
    assert.equal(box.add(message('u', 'c')), 'ok');
    assert.equal(box.add(message('other', 'a')), 'ok');
    assert.equal(box.count, 5);

    // and the channel has room again once a message is gone
    box.remove('u', second.data.version);
    assert.equal(box.add(message('u', 'a')), 'ok');
});

test('mailbox enforces the byte budget', () => {
    const box = new Mailbox({ ...limits, maxBytes: 1000 }, T0);
    assert.equal(box.add(message('a', 'c', T0 + 1000, 'x'.repeat(400))), 'ok');
    assert.equal(
        box.add(message('b', 'c', T0 + 1000, 'x'.repeat(400))),
        'over-budget',
    );

    box.expire(T0 + 1000);
    assert.equal(box.bytes, 0);
    assert.equal(box.add(message('b', 'c', T0 + 1000, 'x'.repeat(400))), 'ok');
});

test('mailbox removes and expires messages', () => {
    const box = new Mailbox(limits, T0);
    const a = message('u', 'a', T0 + 1000);
    const b = message('u', 'b', T0 + 5000);
    const c = message('w', 'a', T0 + 1000);
    box.add(a);
    box.add(b);
    box.add(c);

    assert.deepStrictEqual(box.get('u', T0), [a, b]);
    assert.equal(box.remove('u', a.data.version), true);
    assert.equal(box.remove('u', a.data.version), false);
    assert.deepStrictEqual(box.get('u', T0), [b]);

    assert.equal(box.expire(T0 + 1000), 1);
    assert.deepStrictEqual(box.get('w', T0), []);
    assert.deepStrictEqual([...box.uaids()], ['u']);

    box.remove('u', b.data.version);
    assert.equal(box.count, 0);
    assert.equal(box.bytes, 0);
    assert.equal(box.expire(T0 + 60_000), 0);
});

test('mailbox hides expired messages before they are dropped', () => {
    const box = new Mailbox(limits, T0);
    const a = message('u', 'a', T0 + 1000);
    const b = message('u', 'b', T0 + 5000);
    box.add(a);
    box.add(b);

    assert.deepStrictEqual(box.get('u', T0 + 999), [a, b]);
    assert.deepStrictEqual(box.get('u', T0 + 1000), [b]);
    assert.equal(box.count, 2);
});

test('mailbox removes all messages of a channel', () => {
    const box = new Mailbox(limits, T0);
    const a = message('u', 'a');
    const b = message('u', 'b');
    box.add(a);
    box.add(message('u', 'a'));
    box.add(b);

    box.removeChannel('u', 'a');
    assert.deepStrictEqual(box.get('u', T0), [b]);
    assert.equal(box.count, 1);

    // and the channel's quota is free again
    assert.equal(box.add(message('u', 'a')), 'ok');
    assert.equal(box.add(message('u', 'a')), 'ok');
});
