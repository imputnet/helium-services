import { assert, assertEquals } from '@std/assert';
import { Ring } from '../lib/mesh/ring.ts';

const keys = Array.from({ length: 20_000 }, (_, i) => `uaid-${i}`);

Deno.test('ring spreads keys evenly', () => {
    const members = ['a', 'b', 'c', 'd', 'e'];
    const ring = new Ring(members);
    const counts = new Map(members.map((m) => [m, 0]));
    for (const key of keys) {
        const first = ring.rank(key)[0];
        counts.set(first, counts.get(first)! + 1);
    }

    for (const [member, count] of counts) {
        const share = count / keys.length;
        assert(Math.abs(share - 0.2) < 0.02, `${member}: ${share}`);
    }
});

Deno.test('ring only moves keys of removed members', () => {
    const before = new Ring(['a', 'b', 'c', 'd']);
    const after = new Ring(['a', 'b', 'd']);

    for (const key of keys) {
        const was = before.rank(key);
        const is = after.rank(key);
        assertEquals(is, was.filter((m) => m !== 'c'));
    }
});

Deno.test('ring ranking is stable and complete', () => {
    const ring = new Ring(['x', 'y', 'z', 'x']);
    assertEquals(ring.size, 3);
    assertEquals(ring.rank('k'), ring.rank('k'));
    assertEquals([...ring.rank('k')].sort(), ['x', 'y', 'z']);
});
