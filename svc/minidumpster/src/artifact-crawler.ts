import { setTimeout as delay } from 'node:timers/promises';

import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { logError, logEvent } from './log.ts';
import {
    ingestSymbolArchive,
    type SymbolIngestAndRequeueResult,
} from './symbols.ts';
import {
    type BuildArtifactKind,
    ingestBuildArtifact,
} from './build-artifacts.ts';
import {
    githubApiHeaders,
    GithubHttpError,
    githubHttpError,
} from './github.ts';

const GITHUB_API = 'https://api.github.com';
const MAX_RELEASES = 10;
const MAX_ARTIFACT_PAGES = 10;
const MAX_ATTEMPTS = 5;

const HELIUM_REPOS = [
    'imputnet/helium-macos',
    'imputnet/helium-windows',
    'imputnet/helium-linux',
] as const;

interface GithubRelease {
    tag_name: string;
    draft: boolean;
}

interface GithubCommit {
    sha: string;
}

interface GithubArtifact {
    id: number;
    name: string;
    size_in_bytes: number;
    created_at: string;
    expired: boolean;
    workflow_run: {
        id: number;
        head_sha: string;
    } | null;
}

interface GithubArtifactsPage {
    total_count: number;
    artifacts: GithubArtifact[];
}

interface GithubJobsPage {
    jobs: Array<{ name: string; conclusion: string | null }>;
}

interface ArtifactCrawlerDeps {
    db: Db;
    config: Config;
    fetchFn?: typeof fetch;
    githubApiUrl?: string;
    ingestFn?: (
        body: ReadableStream<Uint8Array>,
        product: string,
        version: string,
        kind: ArtifactKind,
    ) => Promise<SymbolIngestAndRequeueResult>;
    now?: () => number;
    signal?: AbortSignal;
}

interface Candidate {
    repo: string;
    releaseTag: string;
    artifact: GithubArtifact;
    kind: ArtifactKind;
}

type ArtifactKind = 'symbols' | BuildArtifactKind;

function artifactKind(
    repo: string,
    name: string,
    symbolPattern: RegExp,
): ArtifactKind | null {
    if (
        repo === 'imputnet/helium-macos'
        && /^github_build_artifact_(?:arm64|x86_64)$/i.test(name)
    ) {
        return 'mac-build';
    }
    if (
        repo === 'imputnet/helium-windows'
        && /^build-artifact-(?:arm64|x86_64)$/i.test(name)
    ) {
        return 'windows-build';
    }
    return symbolPattern.test(name) ? 'symbols' : null;
}

async function githubJson<T>(
    fetchFn: typeof fetch,
    url: string,
    token: string,
    signal?: AbortSignal,
): Promise<T> {
    const res = await fetchFn(url, {
        headers: githubApiHeaders(token),
        signal,
    });
    if (!res.ok) {
        throw await githubHttpError(
            `GitHub API for ${new URL(url).pathname}`,
            res,
        );
    }
    return (await res.json()) as T;
}

async function releaseShas(
    fetchFn: typeof fetch,
    api: string,
    repo: string,
    token: string,
    signal?: AbortSignal,
): Promise<Map<string, string>> {
    const releases = await githubJson<GithubRelease[]>(
        fetchFn,
        `${api}/repos/${repo}/releases?per_page=${MAX_RELEASES}`,
        token,
        signal,
    );
    const result = new Map<string, string>();
    for (const release of releases) {
        if (release.draft) {
            continue;
        }

        const commit = await githubJson<GithubCommit>(
            fetchFn,
            `${api}/repos/${repo}/commits/${encodeURIComponent(
                release.tag_name,
            )}`,
            token,
            signal,
        );
        result.set(commit.sha, release.tag_name);
    }
    return result;
}

async function repositoryArtifacts(
    fetchFn: typeof fetch,
    api: string,
    repo: string,
    token: string,
    signal?: AbortSignal,
): Promise<GithubArtifact[]> {
    const artifacts: GithubArtifact[] = [];
    for (let page = 1; page <= MAX_ARTIFACT_PAGES; page++) {
        const body = await githubJson<GithubArtifactsPage>(
            fetchFn,
            `${api}/repos/${repo}/actions/artifacts?per_page=100&page=${page}`,
            token,
            signal,
        );
        artifacts.push(...body.artifacts);
        if (
            artifacts.length >= body.total_count
            || body.artifacts.length === 0
        ) {
            break;
        }
    }
    return artifacts;
}

async function runCreatedRelease(
    fetchFn: typeof fetch,
    api: string,
    repo: string,
    runId: number,
    token: string,
    signal?: AbortSignal,
): Promise<boolean> {
    const body = await githubJson<GithubJobsPage>(
        fetchFn,
        `${api}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
        token,
        signal,
    );
    return body.jobs.some(
        (job) => job.conclusion === 'success' && /release/i.test(job.name),
    );
}

function retryDelayMs(attempts: number): number {
    return Math.min(60_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

function isGithubRateLimit(err: unknown): boolean {
    return err instanceof GithubHttpError && err.rateLimited;
}

async function ingestCandidate(
    deps: ArtifactCrawlerDeps,
    candidate: Candidate,
    attempts: number,
): Promise<void> {
    const { config } = deps;
    const fetchFn = deps.fetchFn ?? fetch;
    const api = (deps.githubApiUrl ?? GITHUB_API).replace(/\/+$/, '');
    const token = config.githubArtifactToken!;
    const { repo, releaseTag, artifact, kind } = candidate;

    logEvent('artifact_crawler_download_started', {
        repo,
        release: releaseTag,
        artifact_id: artifact.id,
        artifact: artifact.name,
        kind,
        bytes: artifact.size_in_bytes,
        attempt: attempts,
    });

    const artifactUrl = `${api}/repos/${repo}/actions/artifacts/${artifact.id}/zip`;
    let result: SymbolIngestAndRequeueResult;
    if (kind !== 'symbols') {
        result = await ingestBuildArtifact(
            artifactUrl,
            artifact.size_in_bytes,
            token,
            kind,
            'helium',
            releaseTag,
            config,
            deps.db,
            fetchFn,
            deps.signal,
        );
    } else {
        const download = await fetchFn(artifactUrl, {
            headers: githubApiHeaders(token),
            redirect: 'follow',
            signal: deps.signal,
        });
        if (!download.ok) {
            throw await githubHttpError('GitHub artifact download', download);
        }
        if (!download.body) {
            throw new Error('GitHub artifact download returned no body');
        }
        result = await (deps.ingestFn
            ? deps.ingestFn(download.body, 'helium', releaseTag, kind)
            : ingestSymbolArchive(
                  download.body,
                  'helium',
                  releaseTag,
                  config,
                  deps.db,
              ));
    }

    logEvent('artifact_crawler_ingested', {
        repo,
        release: releaseTag,
        artifact_id: artifact.id,
        artifact: artifact.name,
        files_extracted: result.filesExtracted,
        debug_ids: result.debugIds.length,
        requeued: result.requeued,
    });
}

export async function crawlArtifactsOnce(
    deps: ArtifactCrawlerDeps,
): Promise<void> {
    const { config, db } = deps;
    const token = config.githubArtifactToken;
    if (!token) {
        return;
    }

    const fetchFn = deps.fetchFn ?? fetch;
    const api = (deps.githubApiUrl ?? GITHUB_API).replace(/\/+$/, '');
    const now = deps.now ?? Date.now;
    const namePattern = new RegExp(config.artifactCrawlerNamePattern, 'i');
    const oldestArtifact =
        now() - config.artifactCrawlerMaxAgeDays * 24 * 60 * 60 * 1000;

    for (const repo of HELIUM_REPOS) {
        try {
            const shas = await releaseShas(
                fetchFn,
                api,
                repo,
                token,
                deps.signal,
            );
            const artifacts = await repositoryArtifacts(
                fetchFn,
                api,
                repo,
                token,
                deps.signal,
            );
            const candidates = artifacts.flatMap((artifact) => {
                const kind = artifactKind(repo, artifact.name, namePattern);
                return !artifact.expired
                    && Date.parse(artifact.created_at) >= oldestArtifact
                    && artifact.workflow_run !== null
                    && shas.has(artifact.workflow_run.head_sha)
                    && kind !== null
                    && artifact.size_in_bytes <= config.artifactCrawlerMaxBytes
                    ? [{ artifact, kind }]
                    : [];
            });

            const releaseRuns = new Map<number, boolean>();
            for (const { artifact, kind } of candidates) {
                const runId = artifact.workflow_run!.id;
                let isReleaseRun = releaseRuns.get(runId);
                if (isReleaseRun === undefined) {
                    isReleaseRun = await runCreatedRelease(
                        fetchFn,
                        api,
                        repo,
                        runId,
                        token,
                        deps.signal,
                    );
                    releaseRuns.set(runId, isReleaseRun);
                }
                if (!isReleaseRun) {
                    continue;
                }

                const releaseTag = shas.get(artifact.workflow_run!.head_sha)!;
                const row = db.registerArtifact(
                    repo,
                    artifact.id,
                    releaseTag,
                    artifact.name,
                );
                if (
                    row.status === 'ingested'
                    || row.status === 'failed'
                    || row.next_attempt_at > now()
                ) {
                    continue;
                }

                const attempts = row.attempts + 1;
                try {
                    await ingestCandidate(
                        deps,
                        { repo, releaseTag, artifact, kind },
                        attempts,
                    );
                    db.markArtifactIngested(repo, artifact.id, attempts, now());
                } catch (err) {
                    const message =
                        err instanceof Error ? err.message : String(err);
                    if (isGithubRateLimit(err)) {
                        db.markArtifactError(
                            repo,
                            artifact.id,
                            message.slice(0, 1000),
                            row.attempts,
                            now() + config.artifactCrawlerPollMs,
                            false,
                        );
                        logError('artifact_crawler_ingest_error', err, {
                            repo,
                            release: releaseTag,
                            artifact_id: artifact.id,
                            artifact: artifact.name,
                            attempts: row.attempts,
                            failed: false,
                            rate_limited: true,
                        });
                        return;
                    }

                    const failed = attempts >= MAX_ATTEMPTS;
                    db.markArtifactError(
                        repo,
                        artifact.id,
                        message.slice(0, 1000),
                        attempts,
                        failed ? 0 : now() + retryDelayMs(attempts),
                        failed,
                    );
                    logError('artifact_crawler_ingest_error', err, {
                        repo,
                        release: releaseTag,
                        artifact_id: artifact.id,
                        artifact: artifact.name,
                        attempts,
                        failed,
                    });
                }
            }
        } catch (err) {
            if (deps.signal?.aborted) {
                throw err;
            }

            logError('artifact_crawler_repo_error', err, { repo });
            if (isGithubRateLimit(err)) {
                return;
            }
        }
    }
}

export function startArtifactCrawler(
    deps: Omit<ArtifactCrawlerDeps, 'signal'>,
) {
    if (!deps.config.githubArtifactToken) {
        logEvent('artifact_crawler_disabled', {
            reason: 'GITHUB_ARTIFACT_TOKEN is not set',
        });
        return { stop: () => Promise.resolve() };
    }

    const abort = new AbortController();
    const { signal } = abort;
    const loop = (async () => {
        while (!signal.aborted) {
            try {
                await crawlArtifactsOnce({ ...deps, signal });
            } catch (err) {
                if (!signal.aborted) {
                    logError('artifact_crawler_error', err);
                }
            }

            await delay(deps.config.artifactCrawlerPollMs, undefined, {
                signal,
            }).catch((err) => {
                if (!signal.aborted) throw err;
            });
        }
    })();

    logEvent('artifact_crawler_started', {
        repos: HELIUM_REPOS,
        poll_ms: deps.config.artifactCrawlerPollMs,
        max_bytes: deps.config.artifactCrawlerMaxBytes,
        max_age_days: deps.config.artifactCrawlerMaxAgeDays,
    });

    return {
        stop() {
            abort.abort();
            return loop;
        },
    };
}

export const _test = { artifactKind };
