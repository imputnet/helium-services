import type { GithubRelease } from '@helium-services/common/github';

export const getLatestRelease = (releases: GithubRelease[], pre = false) => {
    return releases.find((release) => {
        if (release.draft) {
            return;
        }

        return pre || !release.prerelease;
    });
};
