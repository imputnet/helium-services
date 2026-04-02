import { ServerMessage } from './server-schema.ts';

import * as UAID from './uaid.ts';
import * as g_state from './state.ts';
import type * as C from './client-schema.ts';
import * as Channel from '../webpush/chid.ts';

type HandlerReturn = ServerMessage | null;
type Handler<T extends C.ClientMessage> = (
    state: g_state.ConnectionState,
    message: T,
) => HandlerReturn | Promise<HandlerReturn>;

const handleHello: Handler<C.ClientHello> = async (state, msg) => {
    if (state.uaidInternal) {
        throw 'hello already handled';
    }

    const uaid = msg.uaid ? msg.uaid : await UAID.generate();

    state.uaidInternal = await UAID.unwrap(uaid);
    g_state.onClientConnected(state);

    if (msg.channelIDs) {
        if (msg.channelIDs.length > 1024) {
            throw 'too many channel IDs';
        }

        for (const channel of msg.channelIDs) {
            g_state.onChannelRegistered(state, channel);
        }
    }

    // TODO: handle registration for msg.broadcasts
    return {
        messageType: 'hello',
        uaid,
        status: 200,
        use_webpush: true,
        broadcasts: msg.broadcasts,
    };
};

const handleRegister: Handler<C.ClientRegister> = async (state, msg) => {
    if (!state.uaidInternal) {
        return null;
    }

    g_state.onChannelRegistered(state, msg.channelID);

    return {
        messageType: 'register',
        channelID: msg.channelID,
        status: 200,
        pushEndpoint: await Channel.makeEndpoint(
            state.uaidInternal,
            msg.channelID,
            msg.key,
        ),
    };
};

const handleUnregister: Handler<C.ClientUnregister> = (state, msg) => {
    if (!state.uaidInternal) {
        return null;
    }

    g_state.onChannelUnregistered(state, msg.channelID);

    return {
        messageType: 'unregister',
        channelID: msg.channelID,
        status: 200,
    };
};

const handleBroadcastSubscribe: Handler<C.ClientBroadcastSubscribe> = (
    _state,
    _msg,
) => {
    // TODO: implement broadcasts
    return null;
};

const handleAck: Handler<C.ClientAck> = (_state, _msg) => {
    // We don't care.
    return null;
};

const handleNack: Handler<C.ClientNack> = (_, msg) => {
    g_state.onNackNotification(msg.version);
    return null;
};

const handlePingMessage: Handler<C.ClientPing> = () => {
    return {};
};

export const handleMessage: Handler<C.ClientMessage> = (state, msg) => {
    switch (msg.messageType) {
        case 'hello':
            return handleHello(state, msg);
        case 'register':
            return handleRegister(state, msg);
        case 'unregister':
            return handleUnregister(state, msg);
        case 'broadcastSubscribe':
            return handleBroadcastSubscribe(state, msg);
        case 'ack':
            return handleAck(state, msg);
        case 'nack':
            return handleNack(state, msg);
        case 'ping':
        case undefined:
            return handlePingMessage(state, msg);
    }
};
