import { env } from '../env.ts';
import { counters, gauge } from '../stats.ts';
import * as Mesh from '../mesh/mesh.ts';
import type { MemberId, RouteStatus } from '../mesh/protocol.ts';
import { Mailbox, type StoredMessage } from './mailbox.ts';

// Stores messages until they're acked, and knows where their UA is.

type Presence = {
    member: MemberId;
    conn: string;
};

const mailbox = new Mailbox({
    perChannel: env.maxQueuedPerChannel,
    maxBytes: env.maxMailboxBytes,
});

const presence = new Map<string, Presence>();

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

export const onRoute = (msg: StoredMessage): RouteStatus => {
    const result = mailbox.add(msg);
    if (result === 'over-budget') {
        return 'overloaded';
    } else if (result !== 'ok') {
        return result;
    }

    deliver(msg.uaid, [msg]);
    return 'ok';
};

export const onRemove = (uaid: string, version: string) => {
    mailbox.remove(uaid, version);
};

export const onAck = (uaid: string, versions: string[]) => {
    for (const version of versions) {
        mailbox.remove(uaid, version);
    }
};

const forget = (from: MemberId, uaid: string, conn: string) => {
    const where = presence.get(uaid);
    if (where?.member === from && where.conn === conn) {
        presence.delete(uaid);
    }
};

export const onPresence = (
    from: MemberId,
    uaid: string,
    conn: string,
    up: boolean,
) => {
    if (!up) {
        return forget(from, uaid, conn);
    }

    presence.set(uaid, { member: from, conn });
    deliver(uaid, mailbox.get(uaid));
};

export const onUndeliverable = forget;

export const onUnregister = (uaid: string, chid: string) => {
    mailbox.removeChannel(uaid, chid);
};

setInterval(() => {
    counters.expiredMessages += mailbox.expire();
}, 1000).unref();
