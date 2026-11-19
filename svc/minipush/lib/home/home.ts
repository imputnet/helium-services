import { env } from '../env.ts';
import { isDraining } from '../lifecycle.ts';
import * as Router from '../mesh/router.ts';
import { counters, gauge } from '../stats.ts';
import * as Mesh from '../mesh/mesh.ts';
import type {
    Frame,
    HandoffEntry,
    MemberId,
    Presence,
    RouteStatus,
} from '../mesh/protocol.ts';
import { Mailbox, type StoredMessage } from './mailbox.ts';

// Stores messages until they're acked, and knows where their UA is.

const mailbox = new Mailbox({
    perChannel: env.maxQueuedPerChannel,
    maxBytes: env.maxMailboxBytes,
});

const presence = new Map<string, Presence>();
const presenceByMember = new Map<MemberId, Set<string>>();

gauge('queuedMessages', () => mailbox.count);
gauge('queuedBytes', () => mailbox.bytes);

const deliver = (uaid: string, messages: StoredMessage[]) => {
    const where = presence.get(uaid);
    if (where && messages.length > 0) {
        Mesh.send(where.member, {
            t: 'deliver',
            uaid,
            conn: where.conn,
            msgs: messages,
        });
    }
};

export const onRoute = (
    msg: StoredMessage,
): RouteStatus | Promise<RouteStatus> => {
    if (isDraining()) {
        return Router.route(msg);
    }

    const result = mailbox.add(msg);
    if (result === 'over-budget') {
        return 'overloaded';
    } else if (result !== 'ok') {
        return result;
    }

    deliver(msg.uaid, [msg]);
    return 'ok';
};

export const onRemove = async (uaid: string, version: string) => {
    mailbox.remove(uaid, version);

    const homes = Mesh.homes(uaid);
    if (homes.includes(Mesh.self)) {
        return;
    }

    // Follows any handoff of the message on the same link.
    if (!await Router.remove(uaid, version, homes)) {
        throw 'could not pass on removal';
    }
};

export const onAck = (uaid: string, versions: string[]) => {
    for (const version of versions) {
        mailbox.remove(uaid, version);
    }

    // Follows any handoff of the messages on the same link.
    const homes = Mesh.homes(uaid);
    if (!homes.includes(Mesh.self)) {
        for (const home of homes) {
            Mesh.send(home, { t: 'ack', uaid, versions });
        }
    }
};

const setPresence = (uaid: string, where: Presence) => {
    const previous = presence.get(uaid);
    if (previous) {
        presenceByMember.get(previous.member)?.delete(uaid);
    }

    presence.set(uaid, where);

    let uaids = presenceByMember.get(where.member);
    if (!uaids) {
        uaids = new Set();
        presenceByMember.set(where.member, uaids);
    }

    uaids.add(uaid);
};

const forget = (from: MemberId, uaid: string, conn: string) => {
    const where = presence.get(uaid);
    if (where?.member === from && where.conn === conn) {
        presence.delete(uaid);
        presenceByMember.get(from)?.delete(uaid);
    }
};

// The member re-announces its UAs once the link is back.
export const onMemberDown = (member: MemberId) => {
    for (const uaid of presenceByMember.get(member) ?? []) {
        presence.delete(uaid);
    }

    presenceByMember.delete(member);
};

// Ties are broken the same way on every home.
const isNewer = (a: Presence, b: Presence) =>
    a.since !== b.since
        ? a.since > b.since
        : a.member !== b.member
        ? a.member > b.member
        : a.conn > b.conn;

const kick = ({ member, conn }: Presence, uaid: string) => {
    Mesh.send(member, { t: 'kick', uaid, conn });
};

export const onPresence = (
    from: MemberId,
    { uaid, conn, up, since }: Extract<Frame, { t: 'presence' }>,
) => {
    if (!up) {
        return forget(from, uaid, conn);
    }

    const current = presence.get(uaid);
    const announced = { member: from, conn, since };
    if (current && (current.member !== from || current.conn !== conn)) {
        if (isNewer(current, announced)) {
            return kick(announced, uaid);
        }

        kick(current, uaid);
    }

    setPresence(uaid, announced);
    deliver(uaid, mailbox.get(uaid));
};

export const onUndeliverable = forget;

export const onUnregister = (uaid: string, chid: string) => {
    mailbox.removeChannel(uaid, chid);
};

export const pendingMessages = () => mailbox.count;

export const onHandoff = (entries: HandoffEntry[]) => {
    for (const { uaid, msgs, presence: where } of entries) {
        for (const msg of msgs) {
            if (mailbox.add(msg) !== 'ok') {
                counters.droppedMessages++;
            }
        }

        const current = presence.get(uaid);
        if (where && (!current || isNewer(where, current))) {
            setPresence(uaid, where);
        }

        deliver(uaid, mailbox.get(uaid));
    }

    // The sender didn't know yet that we're draining.
    if (isDraining()) {
        handOff();
    }
};

const HANDOFF_BATCH = 500;

// Moves messages to the current homes of their UA, unless we're one of them.
const moveMessages = async () => {
    const byTarget = new Map<MemberId, string[]>();
    for (const uaid of [...mailbox.uaids()]) {
        const homes = Mesh.homes(uaid);
        if (homes[0] && !homes.includes(Mesh.self)) {
            const uaids = byTarget.get(homes[0]) ?? [];
            byTarget.set(homes[0], uaids);
            uaids.push(uaid);
        }
    }

    await Promise.all([...byTarget].map(async ([target, uaids]) => {
        for (let i = 0; i < uaids.length; i += HANDOFF_BATCH) {
            const entries = uaids.slice(i, i + HANDOFF_BATCH).map((uaid) => ({
                uaid,
                msgs: mailbox.get(uaid),
                presence: presence.get(uaid),
            }));

            try {
                await Mesh.request(target, { t: 'handoff', entries });
            } catch (e) {
                console.error(`handoff to ${target} failed:`, e);
                continue;
            }

            for (const { uaid, msgs } of entries) {
                for (const { data } of msgs) {
                    mailbox.remove(uaid, data.version);
                }
            }
        }
    }));
};

let lastPass = Promise.resolve();

// One pass at a time, or a pass could copy messages an earlier one is still moving.
export const handOff = () => {
    lastPass = lastPass.then(moveMessages, moveMessages);
    return lastPass;
};

Deno.unrefTimer(setInterval(() => {
    counters.expiredMessages += mailbox.expire();
}, 1000));
