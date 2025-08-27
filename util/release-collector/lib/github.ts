import { headers } from './env.ts';
import type { GithubRelease } from '../../sparkler/types/github.ts';

const sleep = (ms: number) =>
    new Promise<void>(
        (resolve) => setTimeout(resolve, ms),
    );

export const getGithubReleases = async (
    repo: string,
): Promise<GithubRelease[]> => {
    const url = new URL(
        `https://api.github.com/repos/${repo}/releases?per_page=100`,
    );

    const response = await fetch(url, {
        headers: {
            ...headers,
            'Content-Type': 'application/vnd.github+json',
        },
    });

    if (response.status === 429) {
        await sleep(5000);
        return getGithubReleases(repo);
    }

    if (!response.ok) {
        console.log(response);
        throw 'response is not ok';
    }

    return await response.json();
};

export const getLatestRelease = (releases: GithubRelease[], pre = false) => {
    return releases.find((release) => {
        if (release.draft) {
            return;
        }

        return pre || !release.prerelease;
    });
};
