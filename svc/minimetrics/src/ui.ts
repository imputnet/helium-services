import { Eta } from 'eta';
import { fileURLToPath } from 'node:url';

import { dayToIso, type Filter, type SegmentOptions } from './db.ts';
import type { Bucket } from './uma.ts';
import type { Summary } from './stats.ts';
import type { Comparison, RankedChange, VersionChoice } from './compare.ts';

const eta = new Eta({
    views: fileURLToPath(new URL('./templates', import.meta.url)),
    cache: true,
    autoEscape: true,
});

export const RANGES = [1, 7, 30, 90] as const;

const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const helpers = {
    n: (v: number | null | undefined) => v == null ? '-' : nf.format(v),
    v: (v: number | null | undefined) => v == null ? '-' : compact.format(v),
    change: (x: number | null) =>
        x === null || !Number.isFinite(x)
            ? '-'
            : `${x > 0 ? '+' : ''}${compact.format(x * 100)}%`,
    /** A histogram name, HTML-escaped, with line break opportunities after
     * each dot. Output with <%~ %>, not <%= %>. */
    name: (name: string) =>
        name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
            .replaceAll('.', '.<wbr>'),
    pct: (part: number, whole: number) => {
        if (whole === 0) {
            return '-';
        }

        const pct = (part / whole) * 100;

        return part > 0 && pct < 0.01 ? '<0.01%' : `${compact.format(pct)}%`;
    },
    /** Bar width in percent, with a sliver for any nonzero value. */
    bar: (part: number, max: number) =>
        max === 0 || part === 0
            ? 0
            : Math.max(0.5, Math.round((part / max) * 1000) / 10),
    day: dayToIso,
    bucketLabel: (b: Bucket) =>
        b.max - b.min === 1
            ? nf.format(b.min)
            : `${nf.format(b.min)} - ${nf.format(b.max)}`,
};

export interface PageContext {
    user?: string;
    section?: 'overview' | 'histograms' | 'changes';
    filter: Filter;
    days: number;
    options: SegmentOptions;
    /** The current query string with overrides; null removes a key. */
    query: (over?: Record<string, string | null>) => string;
}

function render<Data>(view: string, data: Data): string {
    return eta.render(view, { ...data, h: helpers, ranges: RANGES });
}

export function messagePage(title: string, message: string): string {
    return render('message', { title, message });
}

export interface PinnedRow {
    hex: string;
    name: string | null;
    overall: Summary;
    comparison: Comparison | null;
}

export function overviewPage(ctx: PageContext, data: {
    pinned: PinnedRow[];
    pinCount: number;
    visible: boolean;
    minUsers: number;
    pair: [string, string] | null;
    today: number;
    daily: { day: number; users: number; logs: number }[];
}): string {
    return render('overview', { ...ctx, title: 'Overview', ...data });
}

export function histogramsPage(ctx: PageContext, data: {
    q: string;
    logs: number;
    names: number;
    rows: {
        hex: string;
        name: string | null;
        logs: number;
        samples: number;
        mean: number | null;
    }[];
}): string {
    return render('histograms', { ...ctx, title: 'Histograms', ...data });
}

export function histogramPage(ctx: PageContext, data: {
    pinned: boolean;
    hex: string;
    name: string | null;
    logs: number;
    histogramLogs: number;
    summary: Summary;
    enumLike: boolean;
    buckets: Bucket[];
    versions: { version: string; summary: Summary; mean: number | null }[];
    daily: {
        day: number;
        logs: number;
        totalLogs: number;
        samples: number;
        mean: number | null;
    }[];
}): string {
    return render('histogram', {
        ...ctx,
        title: data.name ?? data.hex,
        ...data,
    });
}

export function tooFewPage(ctx: PageContext, data: {
    q: string;
    minUsers: number;
}): string {
    return render('too-few', { ...ctx, title: 'Not enough users', ...data });
}

export function changesPage(ctx: PageContext, data: {
    choice: VersionChoice;
    mix: {
        dimension: string;
        rows: { value: string; a: number; b: number }[];
    } | null;
    rows: (RankedChange & { hex: string; name: string | null })[];
}): string {
    return render('changes', {
        ...ctx,
        title: 'Changes',
        compare: data.choice,
        ...data,
    });
}
