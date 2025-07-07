import { env, headers } from './env.ts';
import { sleep } from './util.ts';

import { Asset, CPUArchitecture } from '../types/assets.ts';
import { DownloadableMap, GithubRelease, Release, Version } from '../types/github.ts';

const OLD_VERSION_THRESHOLD_DAYS = 60;
const REFRESH_INTERVAL_MSECS = 1000 * 60 * 60; /* 1 hour */

const getGithubReleases = async (page = 1) => {
    const url = new URL(
        `https://api.github.com/repos/${env.githubRepo}/releases?per_page=100`,
    );
    url.searchParams.set('page', page.toString());

    const response = await fetch(url, {
        headers: {
            ...headers,
            'Content-Type': 'application/vnd.github+json',
        },
    });

    if (response.status === 429) {
        await sleep(5000);
        return getGithubReleases(page);
    }

    if (!response.ok) {
        console.log(response);
        throw 'response is not ok';
    }

    const releases: GithubRelease[] = await response.json();
    return releases;
};

const getAllGithubReleases = async () => {
    const releases: GithubRelease[] = [];

    let temp: GithubRelease[], page = 0;
    do {
        temp = await getGithubReleases(++page);

        const latestRelease = (releases[0] || temp[0])?.published_at;
        if (latestRelease) {
            temp = temp.filter((r) => {
                const delta = new Date(latestRelease).getTime() -
                    new Date(r.published_at).getTime();
                return delta < OLD_VERSION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
            });
        }

        releases.push(...temp);
    } while (temp.length > 0);

    return releases;
};

const expired = () => (
    last_checked_at === undefined ||
    Date.now() - last_checked_at > REFRESH_INTERVAL_MSECS
);

const getDownloadFromRelease = (
    release: GithubRelease,
    arch: CPUArchitecture,
): Asset => {
    for (const asset of release.assets) {
        if (asset.name.endsWith(`_${arch}-macos.dmg`)) {
            return {
                name: asset.name,
                machine_url: asset.url,
                user_facing_url: asset.browser_download_url,
                size: asset.size,
                digest: asset.digest.split('sha256:')[1],
            };
        }
    }

    throw new Error(
        `could not find asset in ${release.tag_name} for arch ${arch}`,
    );
};

const getDeltasFromRelease = (release: GithubRelease, version: string) => {
    const out: Record<Version, DownloadableMap> = {};

    for (const asset of release.assets) {
        if (!asset.name.endsWith('.delta')) {
            continue;
        }

        const [old_version, arch] = asset.name.replace('.delta', '').split('-');
        if (arch !== 'x86_64' && arch !== 'arm64') {
            continue;
        }

        out[old_version] ??= {
            x86_64: null,
            arm64: null,
        };

        out[old_version][arch] = {
            name: `${version}-${asset.name}`,
            machine_url: asset.url,
            user_facing_url: asset.browser_download_url,
            size: asset.size,
            digest: asset.digest.split('sha256:')[1],
        };
    }

    return out;
};

let release_cache: Release[] | undefined;
let last_checked_at: number | undefined;

export const getReleases = async (): Promise<Release[]> => {
    if (!expired() && release_cache) {
        return release_cache;
    }

    const githubReleases = await getAllGithubReleases();
    const reformattedReleases: Release[] = [];

    for (const ghRelease of githubReleases) {
        // pre-helium versioning releases
        if (!ghRelease.tag_name.includes('-')) {
            continue;
        }

        const version = ghRelease.tag_name.split('-')[0];
        const release: Release = {
            version,
            published_at: ghRelease.published_at,
            channel: ghRelease.prerelease ? 'beta' : undefined,
            downloads: {
                arm64: getDownloadFromRelease(ghRelease, 'arm64'),
                x86_64: getDownloadFromRelease(ghRelease, 'x86_64'),
            },
            deltas: getDeltasFromRelease(ghRelease, version),
        };

        reformattedReleases.push(release);
    }

    last_checked_at = Date.now();
    release_cache = reformattedReleases;

    return reformattedReleases;
};
