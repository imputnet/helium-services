import { Eta } from 'eta';
import { fromFileUrl } from '@std/path';

import type {
    ArtifactIngestRow,
    GroupListRow,
    GroupRow,
    ReportRow,
} from './db.ts';
import {
    crashingThread,
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

export interface GroupsPageData {
    groups: GroupListRow[];
    stats: { day: string; n: number }[];
    options: { products: string[]; versions: string[]; platforms: string[] };
    filter: {
        product?: string;
        version?: string;
        platform?: string;
        sort?: string;
    };
}

function chartData(stats: { day: string; n: number }[], days = 14) {
    const countByDay = new Map(stats.map((s) => [s.day, s.n]));
    const now = Date.now();
    const series: { day: string; n: number }[] = [];

    for (let i = days - 1; i >= 0; i--) {
        const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
        series.push({ day, n: countByDay.get(day) ?? 0 });
    }

    const max = Math.max(1, ...series.map((s) => s.n));

    return {
        days,
        total: series.reduce((sum, s) => sum + s.n, 0),
        first: series[0].day,
        last: series[series.length - 1].day,
        series: series.map((s) => ({
            ...s,
            pct: Math.max(3, Math.round((s.n / max) * 100)),
        })),
    };
}

export function groupsPage(data: GroupsPageData, user?: string): string {
    const { groups, filter, options } = data;
    const sort = filter.sort === 'last_seen' ? 'last_seen' : 'count';

    // Href for a column-header sort link, preserving the active filters.
    const sortHref = (sort: string): string => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries({ ...filter, sort })) {
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
        chart: chartData(data.stats),
        countHref: sortHref('count'),
        lastSeenHref: sortHref('last_seen'),
        groups: groups.map((g) => ({
            ...g,
            versions: csv(g.versions).slice(0, 6),
            platforms: csv(g.platforms),
        })),
    });
}

function frameView(f: SymFrame) {
    let loc = '';
    if (f.filename) {
        loc = f.lineno != null ? `${f.filename}:${f.lineno}` : f.filename;
    }

    return {
        fn: f.function ?? f.symbol ?? null,
        addr: f.instruction_addr ?? '?',
        loc,
        mod: f.package?.split(/[\\/]/).pop() ?? '',
    };
}

function threadView(t: SymStacktrace, crashed: boolean) {
    return {
        id: String(t.thread_id ?? '?'),
        name: t.thread_name ?? '',
        crashed,
        frames: t.frames.map(frameView),
    };
}

export function stackHtml(
    resp: SymbolicatorResponse,
    allThreads: boolean,
): string {
    const traces = resp.stacktraces ?? [];
    const crashing = crashingThread(resp);
    const shown = allThreads ? traces : crashing ? [crashing] : [];
    const sys = resp.system_info;

    return render('stack', {
        hasTraces: traces.length > 0,
        crashReason: resp.crash_reason ?? '',
        sysInfo: sys
            ? `${sys.os_name ?? ''} ${sys.os_version ?? ''} ${
                sys.cpu_arch ?? ''
            }`
            : '',
        threads: shown.map((t) => threadView(t, t === crashing)),
    });
}

export function groupPage(
    group: GroupRow,
    reports: ReportRow[],
    latestStack: { reportId: string; html: string } | null,
    user?: string,
): string {
    return render('group', {
        title: group.title,
        user,
        group,
        reports,
        latestStack,
    });
}

export function reportPage(
    report: ReportRow,
    group: GroupRow | null,
    stack: string | null,
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
        annotations,
    });
}

export function uploadPage(user?: string, error?: string): string {
    return render('upload', {
        title: 'Upload crash report',
        section: 'upload',
        user,
        error,
    });
}

export interface SymbolsPageData {
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
    results: ReportRow[],
    user?: string,
): string {
    return render('search', { title: 'Search', user, query, results });
}

export function messagePage(
    title: string,
    message: string,
    user?: string,
): string {
    return render('message', { title, message, user });
}
