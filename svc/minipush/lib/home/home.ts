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
    if (isDraining()) {
        await Router.remove(uaid, version);
    }
};

export const onAck = (uaid: string, versions: string[]) => {
    for (const version of versions) {
        mailbox.remove(uaid, version);
    }

    if (isDraining()) {
        for (const home of Mesh.homes(uaid)) {
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
        if (current.since > since) {
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
        if (where && (!current || current.since < where.since)) {
            setPresence(uaid, where);
        }

        deliver(uaid, mailbox.get(uaid));
    }
};

const HANDOFF_BATCH = 500;

export const handOff = async () => {
    const byTarget = new Map<MemberId, string[]>();
    for (const uaid of [...mailbox.uaids()]) {
        const [target] = Mesh.homes(uaid);
        if (target) {
            byTarget.set(target, [...byTarget.get(target) ?? [], uaid]);
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

Deno.unrefTimer(setInterval(() => {
    counters.expiredMessages += mailbox.expire();
}, 1000));
