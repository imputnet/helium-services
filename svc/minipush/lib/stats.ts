import { stats } from './ua/state.ts';

let _lastStats: string;

const kebabify = (name: string) =>
    name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

const computeStats = () =>
    Object.entries(stats).map(([k, v]) => `${kebabify(k)}: ${v}`).join(', ');

export const logStats = () => {
    const statStr = computeStats();
    if (_lastStats === statStr) {
        return;
    }

    _lastStats = statStr;
    console.log(`[${new Date().toISOString()}] ${statStr}`);
};
