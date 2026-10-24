export const counters = {
    dispatchedMessages: 0,
    expiredMessages: 0,
    nackedMessages: 0,
};

const gauges = new Map<string, () => number>();
export const gauge = (name: string, read: () => number) => {
    gauges.set(name, read);
};

let _lastStats: string;

const kebabify = (name: string) =>
    name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

const computeStats = () =>
    [
        ...[...gauges].map(([k, read]) => [k, read()] as const),
        ...Object.entries(counters),
    ].map(([k, v]) => `${kebabify(k)}: ${v}`).join(', ');

export const logStats = () => {
    const statStr = computeStats();
    if (_lastStats === statStr) {
        return;
    }

    _lastStats = statStr;
    console.log(`[${new Date().toISOString()}] ${statStr}`);
};
