import type { StoredMessage } from '../home/mailbox.ts';

export type MemberId = string;

// ok: stored by the home member
// full: per-uaid/per-channel limits reached
// overloaded: home member is out of memory budget
// unavailable: no home member could be reached
export type RouteStatus = 'ok' | 'full' | 'overloaded' | 'unavailable';

// Frames exchanged between the roles of a member:
// - ingress (webpush POST/DELETE) -> home: route, remove
// - edge (UA websocket) -> home: presence, ack, undeliverable, unregister
// - home -> edge: deliver
export type Frame =
    | { t: 'route'; msg: StoredMessage }
    | { t: 'routed'; status: RouteStatus }
    | { t: 'remove'; uaid: string; version: string }
    | { t: 'presence'; uaid: string; conn: string; up: boolean }
    | { t: 'ack'; uaid: string; versions: string[] }
    | { t: 'undeliverable'; uaid: string; conn: string }
    | { t: 'unregister'; uaid: string; chid: string }
    | { t: 'deliver'; uaid: string; conn: string; msgs: StoredMessage[] };

export type FrameHandler = (
    from: MemberId,
    frame: Frame,
) => Frame | void | Promise<Frame | void>;
