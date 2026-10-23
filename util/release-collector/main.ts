import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
    type GithubRelease,
    getReleases,
} from '@helium-services/common/github';

import { env } from './lib/env.ts';
import { getArchitecture, isDesiredFile } from './lib/filenames.ts';
import { getLatestRelease } from './lib/github.ts';

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
        await readFile(
            path.join(import.meta.dirname, 'platforms.json'),
            'utf8',
        ),
    );

    const manifest: Manifest = {};

    await Promise.all(
        Object.entries(platforms).map(async ([platform, info]) => {
            const releases = await getReleases(info.repository);

            manifest[platform] = {
                stable: processRelease(
                    platform,
                    getLatestRelease(releases, false),
                ),
                beta: processRelease(
                    platform,
                    getLatestRelease(releases, true),
                ),
            };
        }),
    );

    await writeFile(env.outPath, JSON.stringify(manifest));
}
