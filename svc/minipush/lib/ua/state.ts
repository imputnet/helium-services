import { env } from '../env.ts';
import { UUID_SHAPE } from '../util/uuid.ts';
import { expired, NotificationInternal } from '../webpush/notification.ts';
import { assert } from '@std/assert/assert';

export type ConnectionState = {
    ws: WebSocket;
    helloTimeoutId?: number;
    uaidInternal?: string;
    ready?: true;
    channels?: Set<CHID>;
};

type UAID = string;
type CHID = string;
type MessageVersion = string;

type ChannelRecord = {
    uaid: UAID;
    bucket: Set<MessageVersion>;
};

const connectedClients = new Map<UAID, WeakRef<ConnectionState>>();
const channels = new Map<CHID, ChannelRecord>();
const notifications = new Map<MessageVersion, NotificationInternal>();

const getUaid = (state: ConnectionState) => {
    const uaid = state.uaidInternal;
    assert(uaid);

    return uaid;
};

export const stats = {
    get connectedClients() {
        return connectedClients.size;
    },
    get openChannels() {
        return channels.size;
    },
    get queuedMessages() {
        return notifications.size;
    },
    dispatchedMessages: 0,
    expiredMessages: 0,
};

export const onClientConnected = (state: ConnectionState) => {
    const uaid = getUaid(state);
    state.channels = new Set();
    connectedClients.set(uaid, new WeakRef(state));
};

export const onClientDisconnected = (state: ConnectionState) => {
    const uaid = state.uaidInternal;
    if (!uaid) {
        return;
    }

    if (connectedClients.get(uaid)?.deref() !== state) {
        return;
    }

    connectedClients.delete(uaid);
};

export const onChannelRegistered = (state: ConnectionState, chid: string) => {
    const uaid = getUaid(state);
    if (!UUID_SHAPE.test(chid)) {
        throw 'invalid channel ID';
    }

    state.channels!.add(chid);

    if (!channels.has(chid)) {
        channels.set(chid, {
            uaid,
            bucket: new Set(),
        });
    } else if (channels.get(chid)?.uaid !== uaid) {
        throw `cannot take over another UAID's channel`;
    }
};

export const onChannelUnregistered = (state: ConnectionState, chid: string) => {
    const uaid = getUaid(state);
    const record = channels.get(chid);
    if (!record) {
        return;
    }

    if (record.uaid !== uaid) {
        return;
    }

    for (const messageId of record.bucket) {
        notifications.delete(messageId);
    }

    channels.delete(chid);
    state.channels!.delete(chid);
};

const maybeSendImmediately = (message: NotificationInternal) => {
    const chid = message.data.channelID;
    const uaid = channels.get(chid)?.uaid;
    if (!uaid) {
        return false;
    }

    const client = connectedClients.get(uaid);
    const ref = client?.deref();
    if (ref && ref.channels?.has(chid)) {
        return sendMessage(ref, message);
    }

    return false;
};

export const onNewNotification = (message: NotificationInternal) => {
    const chid = message.data.channelID;
    if (maybeSendImmediately(message)) {
        return true;
    }

    let bucket: Set<MessageVersion> = new Set();
    if (!channels.has(chid)) {
        channels.set(chid, { uaid: message.uaid, bucket });
    } else {
        bucket = channels.get(chid)!.bucket;
    }

    if (bucket.size >= env.maxQueuedPerChannel) {
        return false;
    }

    bucket.add(message.data.version);
    notifications.set(message.data.version, message);
    return true;
};

export const onDeleteNotification = (id: string) => {
    const message = notifications.get(id);
    if (!message) {
        return;
    }

    message.delete = true;
    notifications.delete(id);
};

export const onNackNotification = (version: string) => {
    const message = notifications.get(version);
    if (!message) {
        return;
    }

    delete message.delete;
    maybeSendImmediately(message);
};

const sendMessage = (
    state: ConnectionState,
    notification: NotificationInternal,
) => {
    if (!state.ready || notification.delete) {
        return false;
    }

    state?.ws.send(JSON.stringify(notification.data));
    notification.delete = true;
    stats.dispatchedMessages++;
    return true;
};

const onTick = () => {
    for (const [chid, { uaid, bucket }] of channels) {
        const state = uaid && connectedClients.get(uaid)?.deref();
        const expectingMessage = state && state.channels?.has(chid);

        for (const id of bucket) {
            const noti = notifications.get(id);

            if (!noti) {
                bucket.delete(id);
                continue;
            } else if (expired(noti)) {
                noti.delete = true;
                stats.expiredMessages++;
            } else if (expectingMessage) {
                sendMessage(state, noti);
            }

            if (noti.delete) {
                bucket.delete(id);
                notifications.delete(noti.data.version);
            }
        }

        if (bucket.size === 0 && !expectingMessage) {
            channels.delete(chid);
        }
    }
};

Deno.unrefTimer(setInterval(onTick, 1000));
