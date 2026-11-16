import type { VersionBucketRow, VersionUsage } from './db.ts';
import { isEnumLike, summarize, type Summary } from './stats.ts';
import type { Bucket } from './uma.ts';

export const MIN_SAMPLES = 100;

/** How far beyond sampling noise a change must be to count. Effective
 * sample sizes are counted in logs, not samples, but logs from one install
 * are still correlated, so this is set well above the usual 2. */
export const MIN_SCORE = 4;

export interface Comparison {
    a: Summary;
    b: Summary;
    enumLike: boolean;
    /** Share of samples that would have to move bucket to turn one
     * distribution into the other (total variation distance, 0..1). */
    shift: number;
    p50Change: number | null;
    p95Change: number | null;
    /** How many noise levels the change is: for timings and sizes, the
     * larger of the median and p95 moves; for enums, the shift. */
    score: number;
    significant: boolean;
}

const key = (b: Bucket) => `${b.min}:${b.max}`;
const total = (x: Bucket[]) => x.reduce((n, y) => n + y.count, 0);

export function cdf(buckets: Bucket[], x: number): number {
    const n = total(buckets);
    let below = 0;

    for (const b of buckets) {
        if (b.max <= x) {
            below += b.count;
        } else if (b.min < x) {
            below += (b.count * (x - b.min)) / (b.max - b.min);
        }
    }

    return n === 0 ? 0 : below / n;
}

/** Inverse of cdf: the value below which a share q of samples falls. Unlike
 * stats.percentile it never snaps to a bucket edge, so that
 * cdf(x, quantile(x, q)) === q and a quantile test on identical
 * distributions comes out exactly zero. */
export function quantile(buckets: Bucket[], q: number): number | null {
    const n = total(buckets);

    if (n === 0) {
        return null;
    }

    const target = q * n;
    let acc = 0;

    for (const b of buckets) {
        if (b.count > 0 && acc + b.count >= target) {
            return b.min + ((target - acc) / b.count) * (b.max - b.min);
        }

        acc += b.count;
    }

    return buckets[buckets.length - 1].max;
}

/** `logsA` and `logsB` are the effective sample sizes (logs containing the
 * histogram); they default to sample counts. */
export function compareBuckets(
    a: Bucket[],
    b: Bucket[],
    logsA = total(a),
    logsB = total(b),
): Comparison {
    const na = total(a);
    const nb = total(b);
    const counts = new Map<string, [number, number]>();

    for (const x of a) {
        counts.set(key(x), [x.count, 0]);
    }

    for (const x of b) {
        const c = counts.get(key(x)) ?? [0, 0];
        counts.set(key(x), [c[0], x.count]);
    }

    const scale = 1 / Math.max(1, logsA) + 1 / Math.max(1, logsB);
    let shift = 0;
    let noise = 0;

    for (const [ca, cb] of counts.values()) {
        shift += Math.abs(ca / na - cb / nb);
        // Expected |pa - pb| for a bucket if both versions shared one
        // distribution: sqrt(2/pi) times its standard deviation.
        const p = (ca + cb) / (na + nb);
        noise += Math.sqrt((2 / Math.PI) * p * (1 - p) * scale);
    }

    shift /= 2;
    noise /= 2;

    const sa = summarize(a);
    const sb = summarize(b);
    const enumLike = isEnumLike(a) && isEnumLike(b);

    const change = (x: number | null, y: number | null) =>
        enumLike || !x || y === null ? null : y / x - 1;

    // For timings and sizes: does b's quantile sit at the same quantile of
    // a? Under no change, the share of a below it varies with standard
    // deviation sqrt(q(1 - q)(1/logsA + 1/logsB)).
    const quantileScore = (q: number) => {
        const at = quantile(b, q);

        return at === null
            ? 0
            : Math.abs(cdf(a, at) - q) / Math.sqrt(q * (1 - q) * scale);
    };

    const score = enumLike
        ? (shift - noise) / (noise / 2)
        : Math.max(quantileScore(0.5), quantileScore(0.95));

    return {
        a: sa,
        b: sb,
        enumLike,
        shift,
        p50Change: change(sa.p50, sb.p50),
        p95Change: change(sa.p95, sb.p95),
        score,
        significant: score >= MIN_SCORE,
    };
}

export interface RankedChange extends Comparison {
    hash: bigint;
    /** The OS the change was found on, or null for all of them. */
    os: string | null;
}

export function rankChanges(
    rows: VersionBucketRow[],
    logs: Map<bigint, [number, number]>,
    versions: [string, string],
    os: string | null = null,
): RankedChange[] {
    const byHash = new Map<bigint, [Bucket[], Bucket[]]>();

    for (const r of rows) {
        let entry = byHash.get(r.hash);

        if (!entry) {
            entry = [[], []];
            byHash.set(r.hash, entry);
        }

        entry[r.version === versions[0] ? 0 : 1].push(r);
    }

    const out: RankedChange[] = [];

    for (const [hash, [a, b]] of byHash) {
        if (total(a) < MIN_SAMPLES || total(b) < MIN_SAMPLES) {
            continue;
        }

        const [la, lb] = logs.get(hash) ?? [total(a), total(b)];
        const c = compareBuckets(a, b, la, lb);

        if (c.significant) {
            out.push({ hash, os, ...c });
        }
    }

    return out.toSorted((x, y) => y.score - x.score);
}

/** Drops a per-platform row when the same change also shows across all
 * platforms. */
export function mergeChanges(lists: RankedChange[][]): RankedChange[] {
    const best = new Map<string, RankedChange>();

    for (const r of lists.flat()) {
        const k = `${r.hash}:${r.os ?? ''}`;

        if ((best.get(k)?.score ?? -Infinity) < r.score) {
            best.set(k, r);
        }
    }

    const overall = new Set(
        best.values().filter((r) => r.os === null).map((r) => r.hash),
    );

    return [...best.values()]
        .filter((r) => r.os === null || !overall.has(r.hash))
        .toSorted((x, y) => y.score - x.score);
}

const byVersionDesc = (a: string, b: string) =>
    b.localeCompare(a, undefined, { numeric: true });

export interface VersionChoice {
    channel: string | null;
    /** Versions that may be compared, newest first. */
    versions: string[];
    /** Default pair: the previous version and the newest one. */
    pair: [string, string] | null;
}

/** Without a channel filter, versions come from the busiest channel, so
 * stable isn't compared against beta by default. */
export function chooseVersions(
    usage: VersionUsage[],
    channel: string | undefined,
    eligible: (version: string) => boolean,
): VersionChoice {
    const logsByChannel = new Map<string, number>();

    for (const u of usage) {
        logsByChannel.set(
            u.channel,
            (logsByChannel.get(u.channel) ?? 0) + u.logs,
        );
    }

    const busiest = [...logsByChannel].toSorted((a, b) => b[1] - a[1])[0]?.[0]
        ?? null;

    const picked = channel ?? busiest;

    const versions = [
        ...new Set(
            usage.values()
                .filter((u) => u.channel === picked)
                .map((u) => u.version),
        ),
    ].filter(eligible).toSorted(byVersionDesc);

    return {
        channel: picked,
        versions,
        pair: versions.length >= 2 ? [versions[1], versions[0]] : null,
    };
}

/** Total variation distance between two platform mixes. */
export function mixShift(
    a: Map<string, number>,
    b: Map<string, number>,
): number {
    const ta = [...a.values()].reduce((n, x) => n + x, 0);
    const tb = [...b.values()].reduce((n, x) => n + x, 0);

    if (ta === 0 || tb === 0) {
        return 0;
    }

    let d = 0;

    for (const k of new Set([...a.keys(), ...b.keys()])) {
        d += Math.abs((a.get(k) ?? 0) / ta - (b.get(k) ?? 0) / tb);
    }

    return d / 2;
}
