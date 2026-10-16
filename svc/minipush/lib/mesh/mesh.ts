import type { Frame, FrameHandler, MemberId } from './protocol.ts';

export const self: MemberId = 'self';

let handler: FrameHandler | undefined;
export const setHandler = (h: FrameHandler) => {
    handler = h;
};

const dispatch = (from: MemberId, frame: Frame) => {
    if (!handler) {
        throw 'mesh frame handler is not set';
    }

    return handler(from, frame);
};

// Members which store messages for `uaid`, most preferred first.
export const homes = (_uaid: string): MemberId[] => [self];

// Fire and forget.
export const send = (_to: MemberId, frame: Frame) => {
    queueMicrotask(async () => {
        try {
            await dispatch(self, frame);
        } catch (e) {
            console.error('error while handling frame', frame.t, e);
        }
    });
};

// Sends a frame and waits for its response.
export const request = async (_to: MemberId, frame: Frame): Promise<Frame> => {
    await Promise.resolve();
    const response = await dispatch(self, frame);
    if (!response) {
        throw `no response for ${frame.t}`;
    }

    return response;
};
