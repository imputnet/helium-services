import * as Home from '../home/home.ts';
import * as Edge from '../ua/state.ts';
import type { FrameHandler } from './protocol.ts';

export const handleFrame: FrameHandler = (from, frame) => {
    switch (frame.t) {
        case 'route':
            return { t: 'routed', status: Home.onRoute(frame.msg) };
        case 'remove':
            return Home.onRemove(frame.uaid, frame.version);
        case 'presence':
            return Home.onPresence(from, frame.uaid, frame.conn, frame.up);
        case 'ack':
            return Home.onAck(frame.uaid, frame.versions);
        case 'undeliverable':
            return Home.onUndeliverable(from, frame.uaid, frame.conn);
        case 'unregister':
            return Home.onUnregister(frame.uaid, frame.chid);
        case 'deliver':
            return Edge.onDeliver(from, frame.uaid, frame.conn, frame.msgs);
        case 'routed':
            throw 'unexpected response frame';
    }
};
