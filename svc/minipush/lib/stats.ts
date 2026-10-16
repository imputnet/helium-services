export const counters = {
    dispatchedMessages: 0,
    expiredMessages: 0,
    droppedMessages: 0,
    nackedMessages: 0,
};

const gauges = new Map<string, () => number>();
export const gauge = (name: string, read: () => number) => {
    gauges.set(name, read);
};

let _lastStats: string;

const separate = (name: string, separator: string) =>
    name.replace(/[A-Z]/g, (char) => `${separator}${char.toLowerCase()}`);

const kebabify = (name: string) => separate(name, '-');

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

// Prometheus text exposition format.
export const renderMetrics = () => {
    const lines = [];
    for (const [name, read] of gauges) {
        const metric = `minipush_${separate(name, '_')}`;
        lines.push(`# TYPE ${metric} gauge`, `${metric} ${read()}`);
    }

    for (const [name, value] of Object.entries(counters)) {
        const metric = `minipush_${separate(name, '_')}_total`;
        lines.push(`# TYPE ${metric} counter`, `${metric} ${value}`);
    }

    return lines.join('\n') + '\n';
};
