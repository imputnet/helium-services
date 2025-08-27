import * as path from 'jsr:@std/path/join';

import { env } from './lib/env.ts';
import type { GithubRelease } from '../sparkler/types/github.ts';
import { getArchitecture, isDesiredFile } from './lib/filenames.ts';
import { getGithubReleases, getLatestRelease } from './lib/github.ts';

type Platform = string;
type Architecture = 'x86_64' | 'arm64';
type Channel = 'stable' | 'beta';
type DownloadURL = string;

type Platforms = Record<
    Platform,
    { repository: string; architectures: Architecture[] }
>;

type ChannelData = Record<Architecture, DownloadURL | null>;
type Manifest = Record<Platform, Record<Channel, ChannelData | null>>;

const processRelease = (
    platform: Platform,
    release?: GithubRelease,
): ChannelData | null => {
    if (!release) {
        return null;
    }

    const data: ChannelData = {
        x86_64: null,
        arm64: null,
    };

    let hasAny = false;

    for (const asset of release.assets) {
        if (!isDesiredFile(platform, asset.name)) {
            continue;
        }

        data[getArchitecture(asset.name)] = asset.browser_download_url;
        hasAny = true;
    }

    return hasAny ? data : null;
};

if (import.meta.main) {
    const platforms: Platforms = JSON.parse(
        await Deno.readTextFile(path.join(import.meta.dirname!, '/platforms.json')),
    );

    const manifest: Manifest = {};

    await Promise.all(
        Object.entries(platforms).map(async ([platform, info]) => {
            const releases = await getGithubReleases(info.repository);

            manifest[platform] = {
                stable: processRelease(platform, getLatestRelease(releases, false)),
                beta: processRelease(platform, getLatestRelease(releases, true)),
            };
        }),
    );

    Deno.writeTextFileSync(
        env.outPath,
        JSON.stringify(manifest),
    );
}
