import { encodeBase64Url } from '@std/encoding/base64url';
import { assert } from '@std/assert/assert';
import * as Crypto from '../util/crypto.ts';
import * as Mesh from '../mesh/mesh.ts';
import type { MemberId } from '../mesh/protocol.ts';
import type { StoredMessage } from '../home/mailbox.ts';
import { counters, gauge } from '../stats.ts';

// Owns UA websockets.

type UAID = string;
type CHID = string;
type MessageVersion = string;

type Inflight = {
    home: MemberId;
    chid: CHID;
};

export type ConnectionState = {
    ws: WebSocket;
    id: string;
    helloTimeoutId?: ReturnType<typeof setTimeout>;
    uaidInternal?: UAID;
    ready?: true;
    channels: Set<CHID>;
    // messages sent to the UA which it hasn't acked yet, and which member
    // to forward the ack to
    inflight: Map<MessageVersion, Inflight>;
    // home members which were told about this connection
    homes: Set<MemberId>;
};

const connectedClients = new Map<UAID, ConnectionState>();

gauge('connectedClients', () => connectedClients.size);

export const newConnection = (ws: WebSocket): ConnectionState => ({
    ws,
    id: encodeBase64Url(Crypto.rand(9)),
    channels: new Set(),
    inflight: new Map(),
    homes: new Set(),
});

const getUaid = (state: ConnectionState) => {
    const uaid = state.uaidInternal;
    assert(uaid);

    return uaid;
};

// Called once the hello response has been sent to the UA.
export const onClientReady = (state: ConnectionState) => {
    const uaid = getUaid(state);
    connectedClients.set(uaid, state);

    for (const home of Mesh.homes(uaid)) {
        state.homes.add(home);
    }

    announce(state);
};

// Tells the home members where the UA is, which makes them deliver
// whatever they have for it.
const announce = (state: ConnectionState) => {
    const uaid = getUaid(state);
    for (const home of state.homes) {
        Mesh.send(home, { t: 'presence', uaid, conn: state.id, up: true });
    }
};

export const onClientDisconnected = (state: ConnectionState) => {
    const uaid = state.uaidInternal;
    if (!uaid) {
        return;
    }

    if (connectedClients.get(uaid) === state) {
        connectedClients.delete(uaid);
    }

    for (const home of state.homes) {
        Mesh.send(home, { t: 'presence', uaid, conn: state.id, up: false });
    }

    state.homes.clear();
    state.inflight.clear();
};

export const onChannelRegistered = (state: ConnectionState, chid: CHID) => {
    chid = chid.toLowerCase();
    if (state.channels.has(chid)) {
        return;
    }

    state.channels.add(chid);

    // There might be messages waiting for it already. A superseded
    // connection mustn't replace the newer one at the homes.
    if (state.ready && connectedClients.get(getUaid(state)) === state) {
        announce(state);
    }
};

export const onChannelUnregistered = (state: ConnectionState, chid: CHID) => {
    chid = chid.toLowerCase();
    state.channels.delete(chid);

    // The UA won't ack these anymore.
    for (const [version, inflight] of state.inflight) {
        if (inflight.chid === chid) {
            state.inflight.delete(version);
        }
    }

    const uaid = getUaid(state);
    for (const home of state.homes) {
        Mesh.send(home, { t: 'unregister', uaid, chid });
    }
};

const ackToHomes = (
    state: ConnectionState,
    versions: Iterable<MessageVersion>,
) => {
    const byHome = new Map<MemberId, MessageVersion[]>();
    for (const version of versions) {
        const home = state.inflight.get(version)?.home;
        if (!home) {
            continue;
        }

        state.inflight.delete(version);
        byHome.set(home, [...byHome.get(home) ?? [], version]);
    }

    for (const [home, versions] of byHome) {
        Mesh.send(home, { t: 'ack', uaid: getUaid(state), versions });
    }
};

export const onClientAck = (
    state: ConnectionState,
    versions: MessageVersion[],
) => ackToHomes(state, versions);

// We don't attempt redelivery of messages that the UA could not handle,
// they're most likely undecryptable, so we just drop them.
export const onClientNack = (state: ConnectionState, version: string) => {
    counters.nackedMessages++;
    ackToHomes(state, [version]);
};

export const onDeliver = (
    from: MemberId,
    uaid: UAID,
    conn: string,
    messages: StoredMessage[],
) => {
    const state = connectedClients.get(uaid);
    if (
        !state || state.id !== conn || !state.ready ||
        state.ws.readyState !== WebSocket.OPEN
    ) {
        Mesh.send(from, { t: 'undeliverable', uaid, conn });
        return;
    }

    for (const { data } of messages) {
        // Leave messages for channels which the UA hasn't told us about
        // (yet) with the home, it might still register them.
        const chid = data.channelID.toLowerCase();
        if (state.inflight.has(data.version) || !state.channels.has(chid)) {
            continue;
        }

        state.inflight.set(data.version, { home: from, chid });
        state.ws.send(JSON.stringify(data));
        counters.dispatchedMessages++;
    }
};
