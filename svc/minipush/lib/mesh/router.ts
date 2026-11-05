import type { StoredMessage } from '../home/mailbox.ts';
import type { RouteStatus } from './protocol.ts';
import * as Mesh from './mesh.ts';

// Hands a new message over to the member responsible for storing it.
export const route = async (msg: StoredMessage): Promise<RouteStatus> => {
    for (const home of Mesh.homes(msg.uaid)) {
        try {
            const res = await Mesh.request(home, { t: 'route', msg });
            if (res.t === 'routed') {
                return res.status;
            }
        } catch {
            // try the next one
        }
    }

    return 'unavailable';
};

export const remove = (uaid: string, version: string) => {
    for (const home of Mesh.homes(uaid)) {
        Mesh.send(home, { t: 'remove', uaid, version });
    }
};
