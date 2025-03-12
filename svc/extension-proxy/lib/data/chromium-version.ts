import { any, ms, now } from '../util.ts';

const UPDATE_INFO_URL =
    'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=5&offset=0';
const VERSION_REGEX = /^((\d+)\.)+\d+$/;

type CacheData = { versions: string[]; cachedAt: number };
const _cache: CacheData = {
    versions: [],
    cachedAt: -1,
};

const fetchVersions = async () => {
    const response = await fetch(UPDATE_INFO_URL);
    if (!response.ok) {
        throw 'response is not ok';
    }

    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
        throw 'invalid response';
    }

    return data.map((o: unknown) => {
        if (!(o instanceof Object && 'version' in o)) {
            throw 'invalid response';
        }

        const version = o.version;
        if (typeof version !== 'string' || !VERSION_REGEX.test(version)) {
            throw 'missing/invalid version in response';
        }

        return version;
    });
};

export const getRandomVersion = async () => {
    if (_cache.cachedAt + ms.hours(1) < now()) {
        try {
            const newVersions = await fetchVersions();
            _cache.cachedAt = now();
            _cache.versions = newVersions;
        } catch (e) {
            console.error('Error occurred fetching Chromium versions:', e);
        }
    }

    if (_cache.versions.length === 0) {
        throw 'could not get random chrome version';
    }

    return any(_cache.versions);
};
