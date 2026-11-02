import { env } from './env.ts';
import { startDraining } from './lifecycle.ts';
import * as Edge from './ua/state.ts';
import * as Home from './home/home.ts';

export const drain = async () => {
    startDraining();
    console.log('draining');

    await Edge.drain(env.ackGraceMs, env.drainSeconds * 1000);

    const undelivered = Home.pendingMessages();
    if (undelivered > 0) {
        console.warn(`exiting with ${undelivered} undelivered messages`);
    }
};
