import { Eta } from 'eta';
import { fromFileUrl } from '@std/path';
import { basename } from '@std/path/windows';

import type {
    ArtifactIngestRow,
    ChartBreakdown,
    GroupListRow,
    GroupRow,
    ReportDayStat,
    ReportRow,
} from './db.ts';
import {
    crashingThread,
    isSignatureExcludedFrame,
    type SymbolicatorResponse,
    type SymFrame,
    type SymStacktrace,
} from './signature.ts';

function matchAngle(s: string, start: number): number {
    let depth = 0;

    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (c === '<') {
            if (s.slice(i - 8, i) === 'operator') {
                continue;
            }
            if (s.slice(i - 9, i) === 'operator<') {
                continue;
            }
            depth++;
        } else if (c === '>') {
            if (s[i - 1] === '-') {
                continue; // ->
            }
            if (s.slice(i - 8, i) === 'operator') {
                continue;
            }
            if (s.slice(i - 9, i) === 'operator>') {
                continue;
            }
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
}

function matchBrace(s: string, start: number): number {
    let depth = 0;

    for (let i = start; i < s.length; i++) {
        if (s[i] === '{') {
            depth++;
        } else if (s[i] === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
}

export function collapseCppName(name: string, limit = 24): string {
    if (name.length <= limit * 2) {
        return name;
    }

    let out = '';
    let i = 0;

    while (i < name.length) {
        const ch = name[i];
        if (
            ch === '<'
            && /[A-Za-z0-9_]/.test(name[i - 1] ?? '')
            && !/operator[<>]?$/.test(out)
        ) {
            const end = matchAngle(name, i);
            if (end < 0) {
                return name;
            }

            const inner = name.slice(i + 1, end);
            out += inner.length > limit ? '<…>' : `<${inner}>`;
            i = end + 1;
            continue;
        }
        if (ch === '{' && name.startsWith('{lambda(', i)) {
            const end = matchBrace(name, i);
            if (end < 0) {
                return name;
            }

            const whole = name.slice(i, end + 1);
            out += whole.length > limit ? '{lambda}' : whole;
            i = end + 1;
            continue;
        }
        out += ch;
        i++;
    }

    return out;
}

function fmtTime(ms: number | null): string {
    if (!ms) {
        return '—';
    }

    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

const eta = new Eta({
    views: fromFileUrl(new URL('./templates/', import.meta.url)),
    cache: true,
});

// Formatting helpers every page template can call as `it.fmtTime(...)` etc.
// Partials only see what include() passes them, so pages forward these along.
const helpers = { collapseCppName, fmtTime };

function render(template: string, data: Record<string, unknown>): string {
    return eta.render(template, { ...helpers, ...data });
}

function csv(joined: string | null): string[] {
    return (joined ?? '').split(',').filter(Boolean);
}

interface GroupsPageData {
    groups: GroupListRow[];
    stats: ReportDayStat[];
    breakdown: ChartBreakdown;
    options: {
        products: string[];
        versions: string[];
        platforms: string[];
        ptypes: string[];
    };
    filter: {
        product?: string;
        version?: string;
        platform?: string;
        ptype?: string;
        sort?: string;
    };
}

const CHART_DAYS = 14;
const DAY_MS = 86400_000;

export function reportChartSince(): number {
    return Math.floor(Date.now() / DAY_MS) * DAY_MS
        - (CHART_DAYS - 1) * DAY_MS;
}

function chartData(stats: ReportDayStat[], breakdown: ChartBreakdown) {
    const since = reportChartSince();
    const series = Array.from({ length: CHART_DAYS }, (_, i) => ({
        day: new Date(since + i * DAY_MS).toISOString().slice(0, 10),
        n: 0,
        counts: new Map<string | null, number>(),
    }));
    const byDay = new Map(series.map((day) => [day.day, day]));
    const totals = new Map<string | null, number>();

    for (const row of stats) {
        const day = byDay.get(row.day);
        if (!day) continue;

        const label = breakdown === 'total' ? 'Total' : row.segment;
        day.n += row.n;
        day.counts.set(label, (day.counts.get(label) ?? 0) + row.n);
        totals.set(label, (totals.get(label) ?? 0) + row.n);
    }

    const legend = [...totals].sort(([a], [b]) =>
        (a ?? '').localeCompare(b ?? '')
    ).map(([value, total], i) => ({
        value,
        label: value ?? 'Unknown',
        total,
        color: breakdown === 'total'
            ? 'var(--accent)'
            : `hsl(${Math.round(i * 137.508) % 360} 65% 55%)`,
    }));
    const max = Math.max(1, ...series.map((day) => day.n));

    return {
        days: CHART_DAYS,
        breakdown,
        legend: breakdown === 'total' ? [] : legend,
        total: series.reduce((sum, day) => sum + day.n, 0),
        first: series[0].day,
        last: series[CHART_DAYS - 1].day,
        series: series.map(({ day, n, counts }) => ({
            day,
            n,
            pct: n / max * 100,
            segments: legend.flatMap(({ value, label, color }) => {
                const count = counts.get(value);
                return count
                    ? [{ label, color, n: count, pct: count / n * 100 }]
                    : [];
            }),
        })),
    };
}

export function groupsPage(data: GroupsPageData, user?: string): string {
    const { groups, filter, options } = data;
    const sort = filter.sort === 'last_seen' ? 'last_seen' : 'count';

    // Href for a column-header sort link, preserving the active filters.
    const sortHref = (sort: string): string => {
        const params = new URLSearchParams();
        for (
            const [key, value] of Object.entries({
                ...filter,
                breakdown: data.breakdown,
                sort,
            })
        ) {
            if (value) {
                params.set(key, value);
            }
        }

        return `?${params}`;
    };

    return render('groups', {
        title: 'Groups',
        user,
        options,
        filter,
        sort,
        chart: chartData(data.stats, data.breakdown),
        countHref: sortHref('count'),
        lastSeenHref: sortHref('last_seen'),
        groups: groups.map((g) => ({
            ...g,
            versions: csv(g.versions).slice(0, 6),
            platforms: csv(g.platforms),
        })),
    });
}

function frameView(f: SymFrame, index: number) {
    return {
        index,
        fn: f.function ?? f.symbol ?? null,
        addr: f.instruction_addr ?? '?',
        loc: frameLocation(f) ?? '',
        mod: frameModule(f) ?? '',
    };
}

function frameRows(t: SymStacktrace, threadIndex: number) {
    const frames = t.frames.map(frameView);
    const rows: ({ kind: 'frame'; frame: ReturnType<typeof frameView> } | {
        kind: 'fold';
        id: string;
        frames: ReturnType<typeof frameView>[];
    })[] = [];

    let prefixEnd = 0;
    while (
        prefixEnd < frames.length
        && isSignatureExcludedFrame(t.frames[prefixEnd])
    ) {
        prefixEnd++;
    }

    if (prefixEnd >= 2) {
        rows.push({
            kind: 'fold',
            id: `stack-fold-${threadIndex}-0`,
            frames: frames.slice(0, prefixEnd),
        });
    } else if (prefixEnd === 1) {
        rows.push({ kind: 'frame', frame: frames[0] });
    }

    rows.push(
        ...frames.slice(prefixEnd).map((frame) => ({
            kind: 'frame' as const,
            frame,
        })),
    );

    return rows;
}

function threadView(
    t: SymStacktrace,
    crashed: boolean,
    threadIndex: number,
) {
    return {
        id: String(t.thread_id ?? '?'),
        name: t.thread_name ?? '',
        crashed,
        rows: frameRows(t, threadIndex),
    };
}

function frameFunction(f: SymFrame): string | null {
    return f.function ?? f.symbol ?? null;
}

function frameLocation(f: SymFrame): string | null {
    if (!f.filename) {
        return null;
    }

    return typeof f.lineno === 'number'
        ? `${f.filename}:${f.lineno}`
        : f.filename;
}

function frameModule(f: SymFrame): string | null {
    return f.package ? basename(f.package) : null;
}

function systemInfo(resp: SymbolicatorResponse): string {
    const sys = resp.system_info;
    return [
        sys?.os_name,
        sys?.os_version,
        sys?.cpu_arch,
    ].filter((a) => a).join(' ');
}

function frameText(f: SymFrame, index: number): string {
    const fn = frameFunction(f) ?? f.instruction_addr ?? '?';
    const parts = [`#${index}`, fn];
    const loc = frameLocation(f);
    if (loc) {
        parts.push(`at ${loc}`);
    }
    const mod = frameModule(f);
    if (mod) {
        parts.push(`in ${mod}`);
    }
    if (f.instruction_addr) {
        parts.push(`[${f.instruction_addr}]`);
    }

    return parts.join(' ');
}

export function reportCopyText(
    report: ReportRow,
    group: GroupRow | null,
    resp: SymbolicatorResponse,
): string {
    const annotations = Object.entries(
        JSON.parse(report.annotations || '{}') as Record<string, string>,
    );
    const crashing = crashingThread(resp);
    const sections: string[] = [];
    const summary = ['# Crash report'];
    const maybePush = (
        name: string,
        value: string | number | null | undefined,
    ) => {
        const text = String(value ?? '').trim();
        if (text) {
            summary.push(`${name}: ${text}`);
        }
    };

    maybePush('Report ID', report.id);
    maybePush('Group', group?.title);
    maybePush('Product', report.product);
    maybePush('Version', report.version);
    maybePush('Platform', report.platform);
    maybePush('Process Type', report.ptype);
    maybePush('Channel', report.channel);
    maybePush('Crash Reason', resp.crash_reason);
    maybePush('Crash Details', resp.crash_details);
    maybePush('System', systemInfo(resp));
    sections.push(summary.join('\n'));

    if (annotations.length > 0) {
        sections.push([
            '## Annotations',
            ...annotations.map(([key, value]) => `${key}: ${value}`),
        ].join('\n'));
    }

    const traces = resp.stacktraces ?? [];
    if (crashing) {
        const name = crashing.thread_name ? ` (${crashing.thread_name})` : '';
        sections.push([
            `## Crashing thread ${crashing.thread_id ?? '?'}${name}`,
            ...crashing.frames.map(frameText),
        ].join('\n'));
    }

    const otherThreads = traces.filter((t) => t !== crashing);
    if (otherThreads.length > 0) {
        const lines = ['## Other threads'];
        for (const thread of otherThreads) {
            const name = thread.thread_name ? ` (${thread.thread_name})` : '';
            lines.push(`Thread ${thread.thread_id ?? '?'}${name}`);
            lines.push(...thread.frames.map(frameText));
            lines.push('');
        }
        sections.push(lines.join('\n').trimEnd());
    }

    return sections.join('\n\n') + '\n';
}

export function stackHtml(
    resp: SymbolicatorResponse,
    allThreads: boolean,
): string {
    const traces = resp.stacktraces ?? [];
    const crashing = crashingThread(resp);
    const shown = allThreads ? traces : crashing ? [crashing] : [];

    return render('stack', {
        hasTraces: traces.length > 0,
        crashReason: resp.crash_reason ?? '',
        sysInfo: systemInfo(resp),
        threads: shown.map((t, i) => threadView(t, t === crashing, i)),
    });
}

export function groupPage(
    data: {
        group: GroupRow;
        reports: ReportRow[];
        latestStack: { reportId: string; html: string } | null;
        stats: ReportDayStat[];
        breakdown: ChartBreakdown;
    },
    user?: string,
): string {
    return render('group', {
        ...data,
        title: data.group.title,
        user,
        chart: chartData(data.stats, data.breakdown),
    });
}

export function reportPage(
    report: ReportRow,
    group: GroupRow | null,
    stack: string | null,
    hasProcessedResponse: boolean,
    githubIssueUrl: string | null,
    retentionDeadline: number,
    user?: string,
): string {
    const annotations = Object.entries(
        JSON.parse(report.annotations || '{}') as Record<string, string>,
    );

    return render('report', {
        title: `Report ${report.id.slice(0, 8)}`,
        user,
        report,
        group,
        stack,
        hasProcessedResponse,
        githubIssueUrl,
        annotations,
        retentionDeadline,
    });
}

export function uploadPage(user: string, error?: string): string {
    return render('upload', {
        title: 'Upload crash report',
        section: 'upload',
        user,
        error,
    });
}

interface SymbolsPageData {
    artifacts: ArtifactIngestRow[];
    bundles: { id: string; updatedAt: number | null }[];
}

function artifactPlatform(repo: string): string {
    if (repo.endsWith('helium-macos')) {
        return 'macOS';
    }
    if (repo.endsWith('helium-windows')) {
        return 'Win';
    }
    if (repo.endsWith('helium-linux')) {
        return 'Linux';
    }

    return repo;
}

function artifactArch(name: string): string {
    if (/(?:^|[-_])(?:arm64|aarch64)(?:$|[-_])/i.test(name)) {
        return 'arm64';
    }
    if (/(?:^|[-_])x86_64(?:$|[-_])/i.test(name)) {
        return 'x86_64';
    }
    if (/(?:^|[-_])x86(?:$|[-_])/i.test(name)) {
        return 'x86';
    }

    return '—';
}

export function symbolsPage(data: SymbolsPageData, user?: string): string {
    const installed = new Set(data.bundles.map((bundle) => bundle.id));
    const releases = new Map<string, ArtifactIngestRow[]>();
    for (const artifact of data.artifacts) {
        const rows = releases.get(artifact.release_tag) ?? [];
        rows.push(artifact);
        releases.set(artifact.release_tag, rows);
    }

    const versions = [...releases.entries()]
        .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
        .map(([version, artifacts]) => ({
            version,
            installed: installed.has(`helium-${version}`),
            artifacts: artifacts.map((artifact) => ({
                ...artifact,
                platform: artifactPlatform(artifact.repo),
                arch: artifactArch(artifact.artifact_name),
            })),
        }));

    return render('symbols', {
        title: 'Symbols',
        section: 'symbols',
        user,
        versions,
        bundles: data.bundles,
        now: Date.now(),
    });
}

export function searchPage(
    query: string,
    results: { groups: GroupRow[]; reports: ReportRow[] },
    user?: string,
): string {
    return render('search', { title: 'Search', user, query, ...results });
}

export function messagePage(
    title: string,
    message: string,
    user?: string,
): string {
    return render('message', { title, message, user });
}
