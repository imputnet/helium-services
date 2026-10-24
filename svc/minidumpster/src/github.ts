import { basename } from 'node:path/win32';

import type { GroupRow, ReportRow } from './db.ts';
import {
    crashingThread,
    platformFromResponse,
    type SymbolicatorResponse,
    type SymFrame,
} from './signature.ts';

const MAX_ISSUE_FRAMES = 30;

export function githubApiHeaders(token: string): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'minidumpster',
    };
}

function oneLine(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function sourceLocation(frame: SymFrame): string | null {
    if (!frame.filename) {
        return null;
    }

    const path = frame.filename.replaceAll('\\', '/');
    const src = path.lastIndexOf('/src/');
    let safePath = path;
    if (src >= 0) {
        safePath = path.slice(src + '/src/'.length);
    } else if (
        path.startsWith('/')
        || /^[A-Za-z]:\//.test(path)
        || path.split('/').includes('..')
    ) {
        safePath = basename(path);
    }

    return frame.lineno == null ? safePath : `${safePath}:${frame.lineno}`;
}

function frameLine(frame: SymFrame, index: number): string {
    const fn = oneLine(frame.function ?? frame.symbol ?? '<unknown>');
    const details = [
        sourceLocation(frame),
        frame.package ? basename(frame.package) : null,
    ].filter(Boolean);

    return `${String(index).padStart(2)}  ${fn}${
        details.length > 0 ? ` (${details.join(', ')})` : ''
    }`;
}

export function githubIssueUrl(
    repository: string,
    template: string,
    report: ReportRow,
    group: GroupRow | null,
    response: SymbolicatorResponse,
): string {
    const title = oneLine(
        group?.title ?? response.crash_reason ?? 'Helium crash',
    );
    const reason = oneLine(response.crash_reason ?? 'Unknown');
    const thread = crashingThread(response);
    const frames = thread?.frames.slice(0, MAX_ISSUE_FRAMES) ?? [];
    const stack = frames.map(frameLine);
    if (thread && thread.frames.length > frames.length) {
        stack.push(`... ${thread.frames.length - frames.length} more frames`);
    }

    const additional = [
        `Crash reason: ${reason}`,
        '',
        '### Crashing thread',
        '',
        '```text',
        ...stack,
        '```',
    ].join('\n');

    const [owner, name] = repository.split('/');
    const url = new URL(
        `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(
            name,
        )}/issues/new`,
    );
    url.searchParams.set('template', template);
    url.searchParams.set('title', `[Bug]: ${title}`.slice(0, 256));
    const os = platformFromResponse(response) ?? report.platform;
    if (os === 'macOS' || os === 'Windows' || os === 'Linux') {
        url.searchParams.set('os', os);
    }
    if (report.version) {
        url.searchParams.set('version', oneLine(report.version));
    }
    url.searchParams.set('description', title);
    url.searchParams.set('crashid', report.id);
    url.searchParams.set('actual', `Helium crashed: ${reason}`);
    url.searchParams.set('expected', 'Helium should not crash.');
    url.searchParams.set('additional', additional);
    return url.toString();
}

export async function checkOrgMembership(
    fetchFn: typeof fetch,
    token: string,
    org: string,
) {
    const res = await fetchFn(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(
            org,
        )}`,
        { headers: githubApiHeaders(token) },
    );

    if (!res.ok) {
        return false;
    }

    const data = (await res.json()) as { state?: string };
    return data.state === 'active';
}

export class GithubHttpError extends Error {
    readonly status: number;
    readonly rateLimited: boolean;

    constructor(message: string, status: number, headers: Headers) {
        super(message);
        this.name = 'GithubHttpError';
        this.status = status;
        this.rateLimited =
            status === 429
            || headers.get('x-ratelimit-remaining') === '0'
            || headers.has('retry-after');
    }
}

export async function githubHttpError(
    context: string,
    response: Response,
): Promise<GithubHttpError> {
    const detail = await response.text().catch(() => '');
    return new GithubHttpError(
        `${context}: ${response.status} ${detail.slice(0, 500)}`,
        response.status,
        response.headers,
    );
}
