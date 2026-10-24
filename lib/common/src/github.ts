import { setTimeout as sleep } from 'node:timers/promises';

import { optional } from './env.ts';

export type GithubRelease = {
    tag_name: string;
    prerelease: boolean;
    draft: boolean;
    published_at: string;
    assets: {
        url: string;
        name: string;
        digest: string;
        size: number;
        browser_download_url: string;
    }[];
};

const token = optional('GITHUB_ACCESS_TOKEN');
const authHeaders: Record<string, string> = token
    ? { authorization: `Bearer ${token}` }
    : {};

export const fetchGithub = async (
    url: string | URL,
    init: RequestInit & { headers?: Record<string, string> } = {},
    retryDelayMs = 5000,
): Promise<Response> => {
    const response = await fetch(url, {
        ...init,
        headers: { ...authHeaders, ...init.headers },
    });

    if (response.status === 429) {
        await sleep(retryDelayMs);
        return fetchGithub(url, init, retryDelayMs);
    }

    if (!response.ok) {
        console.log(response);
        throw new Error('response is not ok');
    }

    return response;
};

export const getReleases = async (
    repo: string,
    page = 1,
): Promise<GithubRelease[]> => {
    const url = new URL(`https://api.github.com/repos/${repo}/releases`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    const response = await fetchGithub(url, {
        headers: { 'Content-Type': 'application/vnd.github+json' },
    });

    return (await response.json()) as GithubRelease[];
};
