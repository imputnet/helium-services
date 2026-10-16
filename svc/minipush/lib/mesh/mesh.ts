import type { Frame, FrameHandler, MemberId } from './protocol.ts';
import type { PeerEvents } from './transport.ts';
import { env } from '../env.ts';
import { isDraining } from '../lifecycle.ts';
import { Ring } from './ring.ts';
import * as Transport from './transport.ts';

export const self: MemberId = env.nodeId;

// How many members know where a UA is connected. Pushes are stored by the
// first reachable one, so a UA can still be reached while one of them is down.
const HOMES_PER_UA = 2;

const ring = new Ring([self, ...Transport.peerIds()]);

let handler: FrameHandler | undefined;

const dispatch = (from: MemberId, frame: Frame) => {
    if (!handler) {
        throw 'mesh frame handler is not set';
    }

    return handler(from, frame);
};

export const isAvailable = (id: MemberId) =>
    id === self ? !isDraining() : Transport.isUp(id);

export const homes = (uaid: string): MemberId[] => {
    const out = [];
    for (const id of ring.rank(uaid)) {
        if (isAvailable(id)) {
            out.push(id);
            if (out.length === HOMES_PER_UA) {
                break;
            }
        }
    }

    return out;
};

export const send = (to: MemberId, frame: Frame) => {
    if (to !== self) {
        Transport.send(to, frame);
        return;
    }

    queueMicrotask(async () => {
        try {
            await dispatch(self, frame);
        } catch (e) {
            console.error('error while handling frame', frame.t, e);
        }
    });
};

export const request = async (to: MemberId, frame: Frame): Promise<Frame> => {
    if (to !== self) {
        return await Transport.request(to, frame);
    }

    await Promise.resolve();
    const response = await dispatch(self, frame);
    if (!response) {
        throw `no response for ${frame.t}`;
    }

    return response;
};

export const announceDraining = Transport.setDraining;

export const start = async (
    h: FrameHandler,
    events: Omit<PeerEvents, 'frame'>,
) => {
    handler = h;
    Transport.start({ ...events, frame: dispatch });

    await Transport.settle(5_000);
};
