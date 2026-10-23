import { getReleases as getGithubReleases } from '@helium-services/common/github';

import { env } from './env.ts';

import type { Asset, CPUArchitecture } from '../types/assets.ts';
import type {
    DownloadableMap,
    GithubRelease,
    Release,
    Version,
} from '../types/github.ts';

const OLD_VERSION_THRESHOLD_DAYS = 30;
const REFRESH_INTERVAL_MSECS = 1000 * 60 * 60; /* 1 hour */

const getAllGithubReleases = async () => {
    const releases: GithubRelease[] = [];

    let temp: GithubRelease[],
        page = 0;
    do {
        temp = await getGithubReleases(env.githubRepo, ++page);

        const beforeFilter = temp.length;
        const latestRelease = (releases[0] || temp[0])?.published_at;
        if (latestRelease) {
            temp = temp.filter((r) => {
                const delta =
                    new Date(latestRelease).getTime()
                    - new Date(r.published_at).getTime();
                return delta < OLD_VERSION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
            });
        }

        releases.push(...temp);
        if (temp.length < beforeFilter) break;
    } while (temp.length > 0);

    return releases;
};

const expired = () =>
    last_checked_at === undefined
    || Date.now() - last_checked_at > REFRESH_INTERVAL_MSECS;

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
        if (ghRelease.draft) {
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
