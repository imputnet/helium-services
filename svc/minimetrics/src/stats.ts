import type { Bucket } from './uma.ts';

export function totalCount(buckets: Bucket[]): number {
    return buckets.reduce((n, b) => n + b.count, 0);
}

/** Interpolates inside the bucket, except width-1 (enum) buckets, which
 * give their exact value. */
export function percentile(buckets: Bucket[], p: number): number | null {
    const total = totalCount(buckets);

    if (total === 0) {
        return null;
    }

    const target = p * total;
    let acc = 0;

    for (const b of buckets) {
        if (b.count > 0 && acc + b.count >= target) {
            if (b.max - b.min <= 1) {
                return b.min;
            }

            return b.min + ((target - acc) / b.count) * (b.max - b.min);
        }

        acc += b.count;
    }

    return buckets[buckets.length - 1].min;
}

export interface Summary {
    samples: number;
    mean: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
}

export function summarize(buckets: Bucket[], sum?: number): Summary {
    const samples = totalCount(buckets);

    return {
        samples,
        mean: sum === undefined || samples === 0 ? null : sum / samples,
        p50: percentile(buckets, 0.5),
        p95: percentile(buckets, 0.95),
        p99: percentile(buckets, 0.99),
    };
}

/** Approximate: uses bucket midpoints, for breakdowns without sums. */
export function approxMean(buckets: Bucket[]): number | null {
    const total = totalCount(buckets);

    if (total === 0) {
        return null;
    }

    const weighted = buckets.reduce(
        (n, b) =>
            n + b.count * (b.max - b.min <= 1 ? b.min : (b.min + b.max) / 2),
        0,
    );

    return weighted / total;
}

export function isEnumLike(buckets: Bucket[]): boolean {
    return buckets.length > 0 && buckets.every((b) => b.max - b.min === 1);
}
