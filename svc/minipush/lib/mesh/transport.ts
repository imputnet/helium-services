import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import * as z from '@zod/zod';
import { env } from '../env.ts';
import * as Crypto from '../util/crypto.ts';
import type { Frame, MemberId } from './protocol.ts';

const PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 5_000;
const DEAD_AFTER_MS = 3 * HEARTBEAT_MS;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const FLUSH_DELAY_MS = 2;
const MAX_BATCH = 512;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

type Wire =
    | { f: Frame; id?: number }
    | { re: number; f?: Frame; err?: true }
    | { draining: boolean }
    | { ping: true };

type Pending = {
    resolve: (f: Frame) => void;
    reject: (e: LinkError) => void;
    timer: ReturnType<typeof setTimeout>;
};

type Peer = {
    id: MemberId;
    url: string;
    ws?: WebSocket;
    draining: boolean;
    lastSeen: number;
    outbox: Wire[];
    flushTimer?: ReturnType<typeof setTimeout>;
    pending: Map<number, Pending>;
    reconnectDelay: number;
};

// `retryable`: the frame definitely wasn't processed.
export class LinkError extends Error {
    retryable: boolean;
    constructor(message: string, retryable: boolean) {
        super(message);
        this.retryable = retryable;
    }
}

export type PeerEvents = {
    up: (id: MemberId) => void;
    down: (id: MemberId) => void;
    draining: (id: MemberId) => void;
    frame: (
        id: MemberId,
        frame: Frame,
    ) => Frame | void | Promise<Frame | void>;
};

const peers = new Map<MemberId, Peer>(
    env.peers
        .filter(({ id }) => id !== env.nodeId)
        .map(({ id, url }) => [id, {
            id,
            url: new URL('mesh', url.endsWith('/') ? url : `${url}/`).href,
            draining: false,
            lastSeen: 0,
            outbox: [],
            pending: new Map(),
            reconnectDelay: 0,
        }]),
);

let events: PeerEvents | undefined;
let selfDraining = false;
let nextRequestId = 1;

export const peerIds = () => peers.keys();

export const isUp = (id: MemberId) => {
    const peer = peers.get(id);
    return !!peer?.ws && !peer.draining;
};

const hello = z.object({
    v: z.literal(PROTOCOL_VERSION),
    from: z.string(),
    to: z.string(),
    draining: z.boolean(),
    challenge: z.string().optional(),
    mac: z.base64url(),
});

type Hello = z.infer<typeof hello>;

const newChallenge = () => encodeBase64Url(Crypto.rand(16));

// Both sides sign each other's challenge, so hellos can't be replayed.
const sign = (h: Omit<Hello, 'mac'>, answering: string) =>
    createHmac('sha256', env.meshSecret)
        .update(
            [h.v, h.from, h.to, h.draining, h.challenge ?? '', answering]
                .join('\n'),
        )
        .digest();

const makeHello = (
    to: MemberId,
    answering: string,
    challenge?: string,
): Hello => {
    const h = {
        v: PROTOCOL_VERSION as typeof PROTOCOL_VERSION,
        from: env.nodeId,
        to,
        draining: selfDraining,
        challenge,
    };

    return { ...h, mac: encodeBase64Url(sign(h, answering)) };
};

const verifyHello = (data: unknown, challenge: string) => {
    const parsed = hello.safeParse(data);
    if (!parsed.success) {
        return;
    }

    const h = parsed.data;
    const peer = peers.get(h.from);
    if (!peer || h.to !== env.nodeId) {
        return;
    }

    const mac = decodeBase64Url(h.mac);
    const expected = sign(h, challenge);
    if (mac.length === expected.length && timingSafeEqual(mac, expected)) {
        return { peer, hello: h };
    }
};

const parse = (data: unknown) => {
    try {
        return JSON.parse(String(data));
    } catch {
        return undefined;
    }
};

const failPending = (peer: Peer, retryable: boolean) => {
    for (const { reject, timer } of peer.pending.values()) {
        clearTimeout(timer);
        reject(new LinkError(`link to ${peer.id} went down`, retryable));
    }

    peer.pending.clear();
};

const onLinkUp = (peer: Peer, ws: WebSocket, h: Hello) => {
    const previous = peer.ws;
    if (previous && previous !== ws) {
        detach(peer);
        previous.close();
    }

    peer.ws = ws;
    peer.draining = h.draining;
    peer.lastSeen = Date.now();
    peer.reconnectDelay = 0;
    peer.outbox = [];

    ws.addEventListener('message', (e) => onMessage(peer, ws, e.data));
    ws.addEventListener('close', () => {
        if (peer.ws === ws) {
            detach(peer);
            events?.down(peer.id);
            scheduleReconnect(peer);
        }
    });

    events?.up(peer.id);
};

const detach = (peer: Peer) => {
    peer.ws = undefined;
    peer.outbox = [];
    clearTimeout(peer.flushTimer);
    peer.flushTimer = undefined;
    failPending(peer, false);
};

const dialsTo = (peer: Peer) => env.nodeId < peer.id;

const dial = (peer: Peer) => {
    let ws: WebSocket;
    try {
        ws = new WebSocket(peer.url);
    } catch {
        return scheduleReconnect(peer);
    }

    const challenge = newChallenge();
    let linked = false;

    const fail = (why: string) => {
        console.error(`mesh: link to ${peer.id} failed: ${why}`);
        ws.close();
    };

    const timeout = setTimeout(
        () => fail('handshake timed out'),
        HANDSHAKE_TIMEOUT_MS,
    );

    ws.addEventListener('message', (e) => {
        const theirs = parse(e.data)?.challenge;
        if (typeof theirs !== 'string') {
            return fail('bad challenge');
        }

        ws.send(
            JSON.stringify({ hello: makeHello(peer.id, theirs, challenge) }),
        );
        ws.addEventListener('message', (e) => {
            const verified = verifyHello(parse(e.data)?.hello, challenge);
            if (verified?.peer !== peer) {
                return fail('bad hello');
            }

            clearTimeout(timeout);
            linked = true;
            onLinkUp(peer, ws, verified.hello);
        }, { once: true });
    }, { once: true });

    ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!linked) {
            scheduleReconnect(peer);
        }
    });

    ws.addEventListener('error', () => {});
};

const scheduleReconnect = (peer: Peer) => {
    if (!dialsTo(peer) || peer.ws) {
        return;
    }

    peer.reconnectDelay = Math.min(
        5_000,
        Math.max(250, peer.reconnectDelay * 2),
    );

    const delay = peer.reconnectDelay * (0.5 + Math.random() / 2);
    Deno.unrefTimer(setTimeout(() => dial(peer), delay));
};

export const accept = (req: Request) => {
    if (req.headers.get('upgrade') !== 'websocket') {
        return new Response(null, { status: 426 });
    }

    const { socket: ws, response } = Deno.upgradeWebSocket(req);
    const challenge = newChallenge();
    const timeout = setTimeout(() => ws.close(), HANDSHAKE_TIMEOUT_MS);

    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ challenge }));
    });

    ws.addEventListener('message', (e) => {
        const verified = verifyHello(parse(e.data)?.hello, challenge);
        const theirs = verified?.hello.challenge;
        if (!verified || !theirs || dialsTo(verified.peer)) {
            ws.close();
            return;
        }

        clearTimeout(timeout);
        ws.send(JSON.stringify({ hello: makeHello(verified.peer.id, theirs) }));
        onLinkUp(verified.peer, ws, verified.hello);
    }, { once: true });

    ws.addEventListener('close', () => clearTimeout(timeout));
    return response;
};

const respond = (peer: Peer, re: number, f: Frame | void) => {
    enqueue(peer, f ? { re, f } : { re, err: true });
};

// Handlers run synchronously and in order, only responses may come later.
const onMessage = (peer: Peer, ws: WebSocket, data: unknown) => {
    if (peer.ws !== ws) {
        return;
    }

    peer.lastSeen = Date.now();

    const batch: Wire[] = parse(data);
    if (!Array.isArray(batch)) {
        ws.close();
        return;
    }

    for (const wire of batch) {
        if ('ping' in wire) {
            continue;
        } else if ('draining' in wire) {
            peer.draining = wire.draining;
            if (wire.draining) {
                events?.draining(peer.id);
            }
        } else if ('re' in wire) {
            const pending = peer.pending.get(wire.re);
            if (pending) {
                peer.pending.delete(wire.re);
                clearTimeout(pending.timer);
                if (wire.f) {
                    pending.resolve(wire.f);
                } else {
                    pending.reject(new LinkError('request failed', false));
                }
            }
        } else {
            const { id, f } = wire;
            const fail = (e: unknown) => {
                console.error('mesh: error handling', f.t, e);
                if (id !== undefined) {
                    respond(peer, id);
                }
            };

            try {
                const result = events?.frame(peer.id, f);
                if (id !== undefined) {
                    Promise.resolve(result)
                        .then((r) => respond(peer, id, r))
                        .catch(fail);
                }
            } catch (e) {
                fail(e);
            }
        }
    }
};

const flush = (peer: Peer) => {
    peer.flushTimer = undefined;
    if (!peer.ws || peer.ws.readyState !== WebSocket.OPEN) {
        peer.outbox = [];
        return;
    }

    while (peer.outbox.length > 0) {
        peer.ws.send(JSON.stringify(peer.outbox.splice(0, MAX_BATCH)));
    }
};

const enqueue = (peer: Peer, wire: Wire) => {
    if (!peer.ws || peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        return false;
    }

    peer.outbox.push(wire);
    peer.flushTimer ??= setTimeout(() => flush(peer), FLUSH_DELAY_MS);
    return true;
};

export const send = (to: MemberId, f: Frame) => {
    const peer = peers.get(to);
    return !!peer && enqueue(peer, { f });
};

export const request = (to: MemberId, f: Frame, timeoutMs = 5_000) => {
    const peer = peers.get(to);
    const id = nextRequestId++;
    return new Promise<Frame>((resolve, reject) => {
        if (!peer || !enqueue(peer, { f, id })) {
            return reject(new LinkError(`${to} is unreachable`, true));
        }

        const timer = setTimeout(() => {
            peer.pending.delete(id);
            reject(new LinkError(`request to ${to} timed out`, false));
        }, timeoutMs);

        peer.pending.set(id, { resolve, reject, timer });
    });
};

export const setDraining = () => {
    selfDraining = true;
    for (const peer of peers.values()) {
        enqueue(peer, { draining: true });
    }
};

const heartbeat = () => {
    const now = Date.now();
    for (const peer of peers.values()) {
        if (!peer.ws) {
            continue;
        }

        if (now - peer.lastSeen > DEAD_AFTER_MS) {
            peer.ws.close();
        } else {
            enqueue(peer, { ping: true });
        }
    }
};

export const start = (e: PeerEvents) => {
    events = e;
    Deno.unrefTimer(setInterval(heartbeat, HEARTBEAT_MS));
    for (const peer of peers.values()) {
        if (dialsTo(peer)) {
            dial(peer);
        }
    }
};

export const settle = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ([...peers.values()].every((p) => p.ws)) {
            return;
        }

        await new Promise((r) => setTimeout(r, 50));
    }
};
