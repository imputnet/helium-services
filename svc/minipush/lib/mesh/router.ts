import type { StoredMessage } from '../home/mailbox.ts';
import type { RouteStatus } from './protocol.ts';
import * as Mesh from './mesh.ts';
import { LinkError } from './transport.ts';

// Hands a new message over to the member responsible for storing it.
export const route = async (msg: StoredMessage): Promise<RouteStatus> => {
    for (const home of Mesh.homes(msg.uaid)) {
        try {
            const res = await Mesh.request(home, { t: 'route', msg });
            if (res.t === 'routed') {
                return res.status;
            }
        } catch (e) {
            // If the home member might have stored the message after all,
            // don't risk storing it twice.
            if (!(e instanceof LinkError && e.retryable)) {
                break;
            }
        }
    }

    return 'unavailable';
};

// Waits for every reachable home, so the message can't show up afterwards.
export const remove = async (uaid: string, version: string) => {
    await Promise.allSettled(
        Mesh.homes(uaid).map((home) =>
            Mesh.request(home, { t: 'remove', uaid, version })
        ),
    );
};
