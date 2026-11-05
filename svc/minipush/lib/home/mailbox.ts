import type { ServerNotification } from '../ua/server-schema.ts';
import { Expiry } from './expiry.ts';

export type StoredMessage = {
    uaid: string;
    expiresAt: number;
    data: ServerNotification;
};

export type AddResult = 'ok' | 'full' | 'over-budget';

// No per-UAID limit, since that would be shared between app servers.
export type MailboxLimits = {
    perChannel: number;
    maxBytes: number;
};

const OVERHEAD_BYTES = 256;

const sizeOf = (msg: StoredMessage) => {
    let bytes = OVERHEAD_BYTES + (msg.data.data?.length ?? 0);
    for (const value of Object.values(msg.data.headers ?? {})) {
        bytes += value.length;
    }

    return bytes;
};

type Entry = {
    msg: StoredMessage;
    bytes: number;
};

type Box = {
    // by message version, in insertion order
    entries: Map<string, Entry>;
    // number of entries per channel
    channels: Map<string, number>;
};

// Messages waiting to be acknowledged by a UA, keyed by UAID.
export class Mailbox {
    #limits: MailboxLimits;
    #boxes = new Map<string, Box>();
    #expiry: Expiry<Entry>;
    #bytes = 0;

    constructor(limits: MailboxLimits, nowMs = Date.now()) {
        this.#limits = limits;
        this.#expiry = new Expiry(nowMs);
    }

    get bytes() {
        return this.#bytes;
    }

    get count() {
        return this.#expiry.size;
    }

    uaids() {
        return this.#boxes.keys();
    }

    add(msg: StoredMessage): AddResult {
        const bytes = sizeOf(msg);
        if (this.#bytes + bytes > this.#limits.maxBytes) {
            return 'over-budget';
        }

        const chid = msg.data.channelID;
        let box = this.#boxes.get(msg.uaid);
        const inChannel = box?.channels.get(chid) ?? 0;
        if (inChannel >= this.#limits.perChannel) {
            return 'full';
        }

        if (!box) {
            box = { entries: new Map(), channels: new Map() };
            this.#boxes.set(msg.uaid, box);
        }

        const entry = { msg, bytes };
        box.entries.set(msg.data.version, entry);
        box.channels.set(chid, inChannel + 1);
        this.#expiry.add(entry, msg.expiresAt);
        this.#bytes += bytes;
        return 'ok';
    }

    // Messages for `uaid` which haven't expired yet.
    get(uaid: string, nowMs = Date.now()): StoredMessage[] {
        const entries = this.#boxes.get(uaid)?.entries.values() ?? [];
        return [...entries]
            .map((e) => e.msg)
            .filter((msg) => msg.expiresAt > nowMs);
    }

    #forget(box: Box, entry: Entry) {
        const { uaid, data } = entry.msg;
        box.entries.delete(data.version);
        if (box.entries.size === 0) {
            this.#boxes.delete(uaid);
        }

        const inChannel = box.channels.get(data.channelID)! - 1;
        if (inChannel > 0) {
            box.channels.set(data.channelID, inChannel);
        } else {
            box.channels.delete(data.channelID);
        }

        this.#bytes -= entry.bytes;
    }

    remove(uaid: string, version: string) {
        const box = this.#boxes.get(uaid);
        const entry = box?.entries.get(version);
        if (!box || !entry) {
            return false;
        }

        this.#forget(box, entry);
        this.#expiry.delete(entry, entry.msg.expiresAt);
        return true;
    }

    removeChannel(uaid: string, chid: string) {
        const entries = this.#boxes.get(uaid)?.entries.values() ?? [];
        for (const { msg } of [...entries]) {
            if (msg.data.channelID === chid) {
                this.remove(uaid, msg.data.version);
            }
        }
    }

    // Drops expired messages, returns how many were dropped.
    expire(nowMs = Date.now()) {
        let expired = 0;
        for (const entry of this.#expiry.due(nowMs)) {
            const box = this.#boxes.get(entry.msg.uaid);
            if (box) {
                this.#forget(box, entry);
                expired++;
            }
        }

        return expired;
    }
}
