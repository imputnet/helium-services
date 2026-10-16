import * as Home from '../home/home.ts';
import * as Edge from '../ua/state.ts';
import type { FrameHandler } from './protocol.ts';
import type { PeerEvents } from './transport.ts';

export const handleFrame: FrameHandler = (from, frame) => {
    switch (frame.t) {
        case 'route':
            return Promise.resolve(Home.onRoute(frame.msg))
                .then((status) => ({ t: 'routed', status }));
        case 'remove':
            return Promise.resolve(Home.onRemove(frame.uaid, frame.version))
                .then(() => ({ t: 'removed' }));
        case 'handoff':
            Home.onHandoff(frame.entries);
            return { t: 'handedoff' };
        case 'presence':
            return Home.onPresence(from, frame);
        case 'ack':
            return Home.onAck(frame.uaid, frame.versions);
        case 'undeliverable':
            return Home.onUndeliverable(from, frame.uaid, frame.conn);
        case 'unregister':
            return Home.onUnregister(frame.uaid, frame.chid);
        case 'deliver':
            return Edge.onDeliver(from, frame.uaid, frame.conn, frame.msgs);
        case 'kick':
            return Edge.onKick(frame.uaid, frame.conn);
        case 'routed':
        case 'removed':
        case 'handedoff':
            throw 'unexpected response frame';
    }
};

export const memberEvents: Omit<PeerEvents, 'frame'> = {
    up: (id) => Edge.resyncPresence(id),
    down: (id) => {
        Home.onMemberDown(id);
        Edge.resyncPresence();
    },
    draining: () => Edge.resyncPresence(),
};
