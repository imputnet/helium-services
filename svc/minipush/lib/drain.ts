import { env } from './env.ts';
import { startDraining } from './lifecycle.ts';
import * as Mesh from './mesh/mesh.ts';
import * as Edge from './ua/state.ts';
import * as Home from './home/home.ts';

export const drain = async () => {
    startDraining();
    Mesh.announceDraining();
    console.log('draining');

    await Home.handOff();

    await Edge.drain(env.ackGraceMs, env.drainSeconds * 1000);

    const undelivered = Home.pendingMessages();
    if (undelivered > 0) {
        console.warn(`exiting with ${undelivered} undelivered messages`);
    }
};
