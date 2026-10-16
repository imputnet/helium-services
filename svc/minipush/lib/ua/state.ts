import { encodeBase64Url } from '@std/encoding/base64url';
import { assert } from '@std/assert/assert';
import * as Crypto from '../util/crypto.ts';
import * as Mesh from '../mesh/mesh.ts';
import type { MemberId } from '../mesh/protocol.ts';
import type { StoredMessage } from '../home/mailbox.ts';
import { counters, gauge } from '../stats.ts';
import { CloseStatus } from '../rfc/6455.ts';
import { env } from '../env.ts';
import { isDraining } from '../lifecycle.ts';

// Owns UA websockets.

type UAID = string;
type CHID = string;
type MessageVersion = string;

type Inflight = {
    home: MemberId;
    chid: CHID;
    sentAt: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_BUFFERED_BYTES = 1024 * 1024;

export type ConnectionState = {
    ws: WebSocket;
    id: string;
    helloTimeoutId?: ReturnType<typeof setTimeout>;
    uaidInternal?: UAID;
    ready?: true;
    // more is sent once the UA has acked what it got so far
    throttled?: true;
    // when the connection became ready
    since: number;
    channels: Set<CHID>;
    // messages sent to the UA which it hasn't acked yet, and which member
    // to forward the ack to
    inflight: Map<MessageVersion, Inflight>;
    // home members which were told about this connection
    homes: Set<MemberId>;
};

const openConnections = new Set<ConnectionState>();
const connectedClients = new Map<UAID, ConnectionState>();

const awaitingAck = new Set<ConnectionState>();

gauge('connectedClients', () => connectedClients.size);

export const newConnection = (ws: WebSocket) => {
    const state: ConnectionState = {
        ws,
        id: encodeBase64Url(Crypto.rand(9)),
        since: 0,
        channels: new Set(),
        inflight: new Map(),
        homes: new Set(),
    };

    openConnections.add(state);
    return state;
};

const getUaid = (state: ConnectionState) => {
    const uaid = state.uaidInternal;
    assert(uaid);

    return uaid;
};

// Called once the hello response has been sent to the UA.
export const onClientReady = (state: ConnectionState) => {
    const uaid = getUaid(state);

    const previous = connectedClients.get(uaid);
    if (previous && previous !== state) {
        previous.ws.close(CloseStatus.GOING_AWAY, 'superseded');
    }

    state.since = Date.now();
    connectedClients.set(uaid, state);
    join(state);
};

const tell = (state: ConnectionState, home: MemberId) => {
    Mesh.send(home, {
        t: 'presence',
        uaid: getUaid(state),
        conn: state.id,
        up: true,
        since: state.since,
    });
};

// Members in `force` are told even if they were told before.
const join = (state: ConnectionState, force?: Set<MemberId>) => {
    for (const home of Mesh.homes(getUaid(state))) {
        if (!state.homes.has(home) || force?.has(home)) {
            state.homes.add(home);
            tell(state, home);
        }
    }
};

// Tells all home members where the UA is, which makes them deliver
// whatever they have for it.
const announce = (state: ConnectionState) => {
    for (const home of state.homes) {
        tell(state, home);
    }
};

let resyncing = false;
let resyncAgain = false;
let resyncForce = new Set<MemberId>();

export const resyncPresence = (force?: MemberId) => {
    if (force) {
        resyncForce.add(force);
    }

    resyncAgain = true;
    if (resyncing) {
        return;
    }

    resyncing = true;
    setTimeout(async () => {
        while (resyncAgain) {
            resyncAgain = false;
            const force = resyncForce;
            resyncForce = new Set();

            let i = 0;
            for (const state of [...connectedClients.values()]) {
                if (connectedClients.get(getUaid(state)) === state) {
                    join(state, force);
                }

                if (++i % 1000 === 0) {
                    await sleep(0);
                }
            }
        }

        resyncing = false;
    }, 50);
};

export const onClientDisconnected = (state: ConnectionState) => {
    openConnections.delete(state);

    const uaid = state.uaidInternal;
    if (!uaid) {
        return;
    }

    if (connectedClients.get(uaid) === state) {
        connectedClients.delete(uaid);
    }

    for (const home of state.homes) {
        Mesh.send(home, {
            t: 'presence',
            uaid,
            conn: state.id,
            up: false,
            since: state.since,
        });
    }

    state.homes.clear();
    state.inflight.clear();
    awaitingAck.delete(state);
};

export const onKick = (uaid: UAID, conn: string) => {
    const state = connectedClients.get(uaid);
    if (state?.id === conn) {
        state.ws.close(CloseStatus.GOING_AWAY, 'superseded');
    }
};

export const onChannelRegistered = (state: ConnectionState, chid: CHID) => {
    chid = chid.toLowerCase();
    if (state.channels.has(chid)) {
        return true;
    } else if (state.channels.size >= env.maxChannelsPerUaid) {
        return false;
    }

    state.channels.add(chid);

    // There might be messages waiting for it already. A superseded
    // connection mustn't replace the newer one at the homes.
    if (state.ready && connectedClients.get(getUaid(state)) === state) {
        announce(state);
    }

    return true;
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

    onInflightRemoved(state);
};

const onInflightRemoved = (state: ConnectionState) => {
    if (state.inflight.size > 0) {
        return;
    }

    awaitingAck.delete(state);

    if (state.throttled) {
        delete state.throttled;
        announce(state);
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

    onInflightRemoved(state);
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
        !state || state.id !== conn || !state.ready || isDraining() ||
        state.ws.readyState !== WebSocket.OPEN
    ) {
        Mesh.send(from, { t: 'undeliverable', uaid, conn });
        return;
    }

    const sentAt = Date.now();
    for (const { data } of messages) {
        // Leave messages for channels which the UA hasn't told us about
        // (yet) with the home, it might still register them.
        const chid = data.channelID.toLowerCase();
        if (state.inflight.has(data.version) || !state.channels.has(chid)) {
            continue;
        }

        if (state.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            state.throttled = true;
            continue;
        }

        state.inflight.set(data.version, { home: from, chid, sentAt });
        state.ws.send(JSON.stringify(data));
        awaitingAck.add(state);
        counters.dispatchedMessages++;
    }
};

const checkAckTimeouts = () => {
    const cutoff = Date.now() - env.ackTimeoutMs;
    for (const state of awaitingAck) {
        const oldest = state.inflight.values().next().value;
        if (!oldest) {
            awaitingAck.delete(state);
        } else if (oldest.sentAt < cutoff) {
            awaitingAck.delete(state);
            state.ws.close(CloseStatus.TIMED_OUT, 'ack timeout');
        }
    }
};

Deno.unrefTimer(
    setInterval(checkAckTimeouts, Math.min(5000, env.ackTimeoutMs / 2)),
);

export const drain = async (ackGraceMs: number, spreadMs: number) => {
    const ackDeadline = Date.now() + ackGraceMs;
    while (awaitingAck.size > 0 && Date.now() < ackDeadline) {
        await sleep(50);
    }

    const states = [...openConnections];
    for (let i = states.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [states[i], states[j]] = [states[j], states[i]];
    }

    const STEP_MS = 100;
    const perStep = Math.ceil(states.length / Math.max(1, spreadMs / STEP_MS));
    for (let i = 0; i < states.length; i += perStep) {
        if (i > 0) {
            await sleep(STEP_MS);
        }

        for (const state of states.slice(i, i + perStep)) {
            state.ws.close(CloseStatus.SERVICE_RESTART, 'draining');
        }
    }

    const closeDeadline = Date.now() + 2000;
    while (openConnections.size > 0 && Date.now() < closeDeadline) {
        await sleep(50);
    }
};
