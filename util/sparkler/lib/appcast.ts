import { stringify } from 'jsr:@libs/xml';

import { getReleases } from './github.ts';
import { getSignatureFor } from './eddsa.ts';
import { getMinimumSystemVersionFor } from './dmg.ts';

import { Asset, CPUArchitecture } from '../types/assets.ts';
import { Appcast, AppcastRelease, Enclosure } from '../types/appcast.ts';
import { Release } from '../types/github.ts';
import { env } from './env.ts';

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
        '@sparkle:edSignature': await getSignatureFor(asset),
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
        minimumSystemVersion = await getMinimumSystemVersionFor(dmg);
    } catch {
        console.warn(`[!] could not get minimum OS version for {dmg.name}, falling back to 10.0`);
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
