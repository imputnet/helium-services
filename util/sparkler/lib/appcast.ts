import { parse, stringify } from 'jsr:@libs/xml';

import { getMinimumVersion, getSignature } from './cache.ts';
import { getReleases } from './github.ts';
import { env } from './env.ts';

import { Appcast, AppcastRelease, Enclosure } from '../types/appcast.ts';
import { Asset, CPUArchitecture } from '../types/assets.ts';
import { Release } from '../types/github.ts';
import { exists } from 'jsr:@std/fs/exists';
import { basename } from 'jsr:@std/path';

const getUrlForAsset = (asset: Asset) => {
    if (env.shouldServeAssets) {
        return (env.urlPrefix ?? '') + `assets/${asset.name}`;
    }

    return asset.user_facing_url;
};

const toEnclosure = async (asset: Asset): Promise<Enclosure> => {
    return {
        '@url': getUrlForAsset(asset),
        '@length': asset.size,
        '@sparkle:edSignature': await getSignature(asset),
        '@type': 'application/octet-stream',
    };
};

const toAppcastRelease = async (
    release: Release,
    arch: CPUArchitecture,
): Promise<AppcastRelease | undefined> => {
    const dmg = release.downloads[arch];
    if (dmg === null) {
        return;
    }

    let minimumSystemVersion = '10.0';
    try {
        minimumSystemVersion = await getMinimumVersion(dmg);
    } catch {
        console.warn(`[!] could not get minimum OS version for ${dmg.name}, falling back to 10.0`);
    }

    const appcastRelease: AppcastRelease = {
        title: release.version,
        pubDate: new Date(release.published_at).toUTCString(),
        'sparkle:version': release.version,
        'sparkle:shortVersionString': release.version,
        'sparkle:minimumSystemVersion': minimumSystemVersion,
        'enclosure': await toEnclosure(dmg),
    };

    if (release.channel) {
        appcastRelease['sparkle:channel'] = release.channel;
    }

    for (const [deltaFrom, arches] of Object.entries(release.deltas)) {
        const delta = arches[arch];
        if (!delta) {
            continue;
        }

        appcastRelease['sparkle:deltas'] ??= {
            enclosure: [],
        };

        appcastRelease['sparkle:deltas'].enclosure.push({
            ...await toEnclosure(delta),
            '@sparkle:deltaFrom': deltaFrom,
        });
    }

    return appcastRelease;
};

export const makeAppcast = async (arch: CPUArchitecture) => {
    const releases = await getReleases();
    const appcast: Appcast = {
        '@version': '1.0',
        '@standalone': 'yes',
        rss: {
            '@version': '2.0',
            '@xmlns:sparkle': 'http://www.andymatuschak.org/xml-namespaces/sparkle',
            channel: {
                title: `Helium (${arch})`,
                item: (await Promise.all(
                    releases.map((release) => toAppcastRelease(release, arch)),
                )).filter((r) => r !== undefined),
            },
        },
    };

    return stringify(appcast);
};

export const getSignaturesAndVersions = async (appcastPath: string) => {
    if (!await exists(appcastPath)) {
        return [];
    }

    const text = await Deno.readTextFile(appcastPath);
    const data = parse(text) as unknown as Appcast;

    return (data.rss.channel.item ?? []).flatMap((item) => [
        {
            filename: basename(item.enclosure['@url']),
            signature: item.enclosure['@sparkle:edSignature'],
            minVersion: item['sparkle:minimumSystemVersion'],
        },
        ...(item['sparkle:deltas']?.enclosure ?? []).map((delta) => ({
            filename: basename(delta['@url']),
            signature: delta['@sparkle:edSignature'],
        })),
    ]);
};
