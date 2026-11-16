// Fills the dev database with a month of made-up but plausible data, written
// through the same code path as real uploads (daily salts, client hashes,
// finalization). Planted findings to look for:
// - 157.0.8103.78 on Windows has slower first/largest contentful paint
// - the 158 beta uses more browser memory and crashes more often
// - one Helium-only histogram has no known name
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { devConfig } from './config.ts';
import { dayOf, Db } from './db.ts';
import { clientHash } from './ingest.ts';
import { hashMetricName, hashNames } from './names.ts';
import { runMaintenance } from './retention.ts';
import type { Bucket, Histogram, UmaLog } from './uma.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 30;
const INSTALLS = 800;

// Deterministic, so reseeding gives the same picture.
let state = 0x5eed;

function rand(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function normal(): number {
    return Math.sqrt(-2 * Math.log(1 - rand()))
        * Math.cos(2 * Math.PI * rand());
}

function lognormal(median: number, sigma: number): number {
    return Math.exp(Math.log(median) + sigma * normal());
}

function poisson(mean: number): number {
    let n = 0;
    let p = Math.exp(-mean);
    let s = p;
    const u = rand();

    while (u > s) {
        n++;
        p *= mean / n;
        s += p;
    }

    return n;
}

function pick<T>(weights: [T, number][]): T {
    let u = rand() * weights.reduce((n, [, w]) => n + w, 0);

    for (const [v, w] of weights) {
        u -= w;

        if (u <= 0) {
            return v;
        }
    }

    return weights[weights.length - 1][0];
}

// Bucket boundaries the way base::Histogram lays out exponential histograms:
// an underflow bucket from 0, log-spaced buckets up to max, and an overflow
// bucket up to INT_MAX.
function exponentialRanges(min: number, max: number, count: number): number[] {
    const ranges = [0, min];
    let current = min;
    const logMax = Math.log(max);

    for (let i = 2; i < count; i++) {
        const logCurrent = Math.log(current);

        const next = Math.round(
            Math.exp(logCurrent + (logMax - logCurrent) / (count - i)),
        );

        current = next > current ? next : current + 1;
        ranges.push(current);
    }

    ranges.push(2 ** 31 - 1);

    return ranges;
}

type Spec =
    | { kind: 'exp'; ranges: number[] }
    | { kind: 'enum' };

const exp = (ranges: number[]): Spec => ({ kind: 'exp', ranges });
const en: Spec = { kind: 'enum' };

const TIMES = exponentialRanges(1, 10_000, 50);
const MEDIUM_TIMES = exponentialRanges(10, 180_000, 50);
const LONG_TIMES = exponentialRanges(1, 3_600_000, 100);
const PAGE_LOAD = exponentialRanges(10, 600_000, 100);
const MEMORY_MB = exponentialRanges(1, 64_000, 100);
const COUNTS = exponentialRanges(1, 5_000, 50);
const SHORT = exponentialRanges(1, 1_000, 50);

class Recorder {
    readonly #samples = new Map<string, { spec: Spec; values: number[] }>();

    add(name: string, spec: Spec, value: number): void {
        let entry = this.#samples.get(name);

        if (!entry) {
            entry = { spec, values: [] };
            this.#samples.set(name, entry);
        }

        entry.values.push(Math.max(0, Math.round(value)));
    }

    histograms(): Histogram[] {
        return [...this.#samples].map(([name, { spec, values }]) => ({
            hash: hashMetricName(name),
            sum: values.reduce((n, v) => n + v, 0),
            buckets: toBuckets(spec, values),
        }));
    }
}

function toBuckets(spec: Spec, values: number[]): Bucket[] {
    const counts = new Map<number, number>();

    if (spec.kind === 'enum') {
        for (const v of values) {
            counts.set(v, (counts.get(v) ?? 0) + 1);
        }

        return [...counts].toSorted(([a], [b]) => a - b)
            .map(([v, count]) => ({ min: v, max: v + 1, count }));
    }

    const { ranges } = spec;

    for (const v of values) {
        let lo = 0;
        let hi = ranges.length - 1;

        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;

            if (ranges[mid] <= v) {
                lo = mid;
            } else {
                hi = mid;
            }
        }

        counts.set(lo, (counts.get(lo) ?? 0) + 1);
    }

    return [...counts].toSorted(([a], [b]) => a - b)
        .map(([i, count]) => ({ min: ranges[i], max: ranges[i + 1], count }));
}

interface Release {
    version: string;
    day: number;
}

const RELEASES: Record<'stable' | 'beta', Release[]> = {
    stable: [
        { version: '156.0.7998.120-64', day: -60 },
        { version: '157.0.8103.61-64', day: -24 },
        { version: '157.0.8103.78-64', day: -9 },
    ],
    beta: [
        { version: '157.0.8103.40-64', day: -60 },
        { version: '158.0.8170.22-64', day: -18 },
        { version: '158.0.8170.45-64', day: -4 },
    ],
};

interface Install {
    clientId: bigint;
    channel: 'stable' | 'beta';
    os: 'macOS' | 'Windows' | 'Linux';
    arch: string;
    firstDay: number;
    lastDay: number;
    activity: number;
    updateLag: number;
    tabs: number;
    profiles: number;
}

function makeInstall(): Install {
    const os = pick<Install['os']>([
        ['macOS', 45],
        ['Windows', 40],
        ['Linux', 15],
    ]);

    const arch = os === 'macOS'
        ? pick([['arm64', 85], ['x86_64', 15]])
        : os === 'Windows'
        ? pick([['x86_64', 94], ['arm64', 6]])
        : pick([['x86_64', 92], ['arm64', 8]]);

    // Most installs predate the window; the rest arrive steadily.
    const firstDay = rand() < 0.6
        ? -DAYS - 1
        : -DAYS + Math.floor(rand() * DAYS);

    return {
        clientId: randomBytes(8).readBigUInt64LE(),
        channel: rand() < 0.1 ? 'beta' : 'stable',
        os,
        arch,
        firstDay,
        lastDay: rand() < 0.12 ? firstDay + Math.floor(rand() * 40) : 1,
        activity: 0.3 + 0.65 * rand(),
        updateLag: rand() < 0.05 ? 25 : -Math.log(1 - rand()) * 2.5,
        tabs: lognormal(9, 0.9),
        profiles: pick([[1, 80], [2, 13], [3, 5], [4, 2]]),
    };
}

function versionOn(install: Install, day: number): string {
    let version = RELEASES[install.channel][0].version;

    for (const r of RELEASES[install.channel]) {
        if (r.day + install.updateLag <= day) {
            version = r.version;
        }
    }

    return version;
}

function makeLog(
    install: Install,
    day: number,
    firstOfDay: boolean,
): UmaLog {
    const version = versionOn(install, day);
    const rec = new Recorder();

    const slowPaint = version === '157.0.8103.78-64' && install.os === 'Windows'
        ? 1.22
        : 1;

    const beta158 = version.startsWith('158.');
    const osStartup = { macOS: 650, Windows: 1150, Linux: 900 }[install.os];
    const osMemory = { macOS: 430, Windows: 360, Linux: 290 }[install.os];

    if (firstOfDay) {
        rec.add(
            'Startup.FirstWebContents.NonEmptyPaint3',
            exp(LONG_TIMES),
            lognormal(osStartup, 0.45),
        );
        rec.add(
            'Startup.BrowserMessageLoopStartTime',
            exp(LONG_TIMES),
            lognormal(osStartup * 0.45, 0.4),
        );
        rec.add('Stability.Counts2', en, 2);
        rec.add('Profile.NumberOfProfiles', en, install.profiles);
    }

    if (rand() < (beta158 ? 0.03 : 0.006)) {
        rec.add('Stability.Counts2', en, 3);
    }

    const loads = poisson(12);

    for (let i = 0; i < loads; i++) {
        const fcp = lognormal(900, 0.85) * slowPaint;
        rec.add(
            'PageLoad.PaintTiming.NavigationToFirstContentfulPaint',
            exp(PAGE_LOAD),
            fcp,
        );
        rec.add(
            'PageLoad.PaintTiming.NavigationToLargestContentfulPaint2',
            exp(PAGE_LOAD),
            fcp * lognormal(1.8, 0.3),
        );

        if (rand() < 0.6) {
            rec.add(
                'PageLoad.InteractiveTiming.UserInteractionLatency.HighPercentile2.MaxEventDuration',
                exp(TIMES),
                lognormal(80, 0.9),
            );
        }

        rec.add(
            'Navigation.MainFrameScheme2',
            en,
            pick([[1, 92], [0, 4], [2, 2], [3, 1], [5, 1]]),
        );

        for (let r = poisson(6); r > 0; r--) {
            rec.add(
                'Net.HttpResponseCode',
                en,
                pick([
                    [200, 850],
                    [304, 60],
                    [204, 30],
                    [302, 15],
                    [301, 8],
                    [404, 20],
                    [403, 7],
                    [500, 4],
                    [503, 3],
                    [429, 3],
                ]),
            );
        }
    }

    rec.add(
        'Memory.Browser.PrivateMemoryFootprint',
        exp(MEMORY_MB),
        lognormal(osMemory * (beta158 ? 1.12 : 1), 0.45),
    );
    const tabs = Math.max(1, install.tabs * lognormal(1, 0.25));
    rec.add('Tabs.TabCount', exp(COUNTS), tabs);

    for (let i = 0; i < Math.min(12, Math.ceil(tabs / 2)); i++) {
        rec.add(
            'Memory.Renderer.PrivateMemoryFootprint',
            exp(MEMORY_MB),
            lognormal(95, 0.7),
        );
    }

    for (let i = poisson(25); i > 0; i--) {
        rec.add(
            'Browser.Tabs.TotalSwitchDuration3',
            exp(TIMES),
            lognormal(45, 0.7),
        );
    }

    for (let i = poisson(40); i > 0; i--) {
        rec.add(
            'Omnibox.CharTypedToRepaintLatency.ToPaint',
            exp(SHORT),
            lognormal(9, 0.5),
        );
        rec.add('Omnibox.QueryTime2', exp(SHORT), lognormal(4, 0.6));
    }

    for (let i = poisson(2); i > 0; i--) {
        rec.add(
            'Session.TotalDuration',
            exp(MEDIUM_TIMES),
            lognormal(1_200_000 / 30, 1),
        );
    }

    if (rand() < 0.15) {
        rec.add(
            'Download.Start.ContentType',
            en,
            pick([[1, 40], [3, 20], [5, 15], [7, 10], [9, 10], [12, 5]]),
        );
    }

    // Helium-only histogram, deliberately missing from the name list.
    for (let i = poisson(3); i > 0; i--) {
        rec.add('Helium.Bangs.Used', en, rand() < 0.7 ? 1 : 0);
    }

    return {
        clientId: install.clientId,
        product: 0,
        version,
        channel: install.channel,
        os: install.os,
        arch: install.arch,
        histograms: rec.histograms(),
    };
}

const NAMES = [
    'Startup.FirstWebContents.NonEmptyPaint3',
    'Startup.BrowserMessageLoopStartTime',
    'Stability.Counts2',
    'Profile.NumberOfProfiles',
    'PageLoad.PaintTiming.NavigationToFirstContentfulPaint',
    'PageLoad.PaintTiming.NavigationToLargestContentfulPaint2',
    'PageLoad.InteractiveTiming.UserInteractionLatency.HighPercentile2.MaxEventDuration',
    'Navigation.MainFrameScheme2',
    'Net.HttpResponseCode',
    'Memory.Browser.PrivateMemoryFootprint',
    'Memory.Renderer.PrivateMemoryFootprint',
    'Tabs.TabCount',
    'Browser.Tabs.TotalSwitchDuration3',
    'Omnibox.CharTypedToRepaintLatency.ToPaint',
    'Omnibox.QueryTime2',
    'Session.TotalDuration',
    'Download.Start.ContentType',
];

if (import.meta.main) {
    const config = devConfig(process.env);
    await mkdir(config.dataDir, { recursive: true });
    const db = new Db(join(config.dataDir, 'db.sqlite'));
    db.upsertNames(hashNames(NAMES));

    const now = Date.now();
    const today = dayOf(now);
    const installs = Array.from({ length: INSTALLS }, makeInstall);
    let logs = 0;

    for (let offset = -DAYS + 1; offset <= 0; offset++) {
        const day = today + offset;
        const date = new Date(day * DAY_MS);
        const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
        // Today only gets the part of the day that has already happened.
        const dayEnd = offset === 0 ? now - day * DAY_MS : DAY_MS;

        for (const install of installs) {
            if (offset < install.firstDay || offset > install.lastDay) {
                continue;
            }

            if (rand() > install.activity * (weekend ? 0.7 : 1)) {
                continue;
            }

            const count = 1 + poisson(1.2);

            for (let i = 0; i < count; i++) {
                const at = day * DAY_MS + Math.floor(rand() * dayEnd);
                const log = makeLog(install, offset, i === 0);
                db.recordLog(randomBytes(20).toString('hex'), log, at, {
                    clientHash: clientHash(db.saltFor(day), install.clientId),
                });
                logs++;
            }
        }

        process.stdout.write(`\rseeded ${date.toISOString().slice(0, 10)}`);
    }

    runMaintenance(db, config, now);
    db.close();
    console.log(
        `\nseeded ${logs} logs from ${INSTALLS} installs over ${DAYS} days`,
    );
}
