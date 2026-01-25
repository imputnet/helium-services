import * as Util from './util.ts';
import * as Cache from './cache.ts';
import * as Allowlist from './allowlist.ts';
import * as Constants from './constants.ts';
import { env } from './env.ts';

import * as Path from '@std/path/posix';

type Asset = {
    content: 'internal' | 'filters';

    // enumeration at: https://github.com/gorhill/uBlock/blob/705e6329ebd258ad71694d6942e340a471a51f76/src/js/3p-filters.js#L232
    // mostly irrelevant for us though
    group?: string;
    parent?: string;
    title?: string;
    tags?: string;

    updateAfter?: number;
    contentURL: string | string[];
    cdnURLs?: string[];
    patchURLs?: string[];
};

type Filename = string;
type AssetFile = Record<Filename, Asset>;

const loadManifestFromGithub = async () => {
    const assetList = await fetch(
        Constants.ASSET_URL,
    ).then((a) => a.text());
    const checksum = await Util.digest(assetList);
    if (checksum !== Constants.FILE_CHECKSUM) {
        throw `checksum does not match: ${checksum}`;
    }

    return JSON.parse(assetList) as AssetFile;
};

const prepareAssetString = async () => {
    const manifest = await loadManifestFromGithub();
    const manifestId = 'assets.json';
    const assetURLs: Record<string, string[]> = {};

    for (const [id, asset] of Object.entries(manifest)) {
        const allUrls = [asset.contentURL, asset.cdnURLs || []].flat();

        delete asset.cdnURLs;

        if (id === manifestId) {
            asset.contentURL = new URL('assets.json', env.baseURL)
                .toString();
            continue;
        }

        const sourceURLs = allUrls.filter(Util.isValidUrl);
        const locals = allUrls.filter((u) => u?.startsWith('assets/'));

        if (!sourceURLs.length) {
            throw `no source for ${asset.title}`;
        }

        const filename = (() => {
            const fn = Path.basename(new URL(sourceURLs[0]).pathname);
            if (fn.endsWith('.txt') || fn.endsWith('.dat')) {
                return fn;
            }

            return 'filters.txt';
        })();

        const reprHash = [
            ...new Uint32Array(
                await crypto.subtle.digest(
                    { name: 'SHA-256' },
                    new TextEncoder().encode(sourceURLs[0]),
                ),
            ),
        ];

        const key = [
            id,
            reprHash[0].toString(16),
            reprHash[1].toString(16),
            filename,
        ].join('/');
        const proxyURL = new URL(key, env.baseURL).toString();

        if (locals.length) {
            asset.contentURL = [
                proxyURL,
                ...locals,
            ];
        } else {
            asset.contentURL = proxyURL;
        }

        if (asset.patchURLs) {
            asset.patchURLs = [
                new URL(Path.dirname(key), env.baseURL).toString(),
            ];
        }

        assetURLs[key] = sourceURLs;
    }

    Allowlist.addEntries(manifestId, assetURLs);

    return JSON.stringify(manifest, null, 4);
};

// https://raw.githubusercontent.com/gorhill/uBlock/34d202f79ddf0172d2b4ae9584192cffccf1f9cc/src/js/assets.js
const INCLUDE_REGEX = /^!#include +(\S+)[^\n\r]*(?:[\n\r]+|$)/;
const prepareFilterlist = async (path: string) => {
    const urls = Allowlist.getURLsForPath(path);
    if (!urls) {
        throw { status: 404, text: 'Not Found' };
    }

    const response = await Util.shotgunFetch(urls);
    const text = await response.text();

    const parentId = path.split('/')[0];
    const toAllowlist: Record<string, string[]> = {};

    const addToAllowlist = (relativePath: string) => {
        return (base: string) => {
            const url = new URL(relativePath, base);
            url.hash = '';

            return url.toString();
        };
    };

    const handleInclude = (line: string) => {
        const includeMatch = INCLUDE_REGEX.exec(line);
        if (includeMatch === null || !includeMatch[1]) {
            console.warn('WARN: erroneous include in ', path, line);
            return;
        }

        const includePath = includeMatch[1];
        const absoluteIncludePath = Path.join(
            Path.dirname(path),
            includePath,
        );

        // This should not happen. Let's skip this include.
        if (
            URL.canParse(includePath)
            || absoluteIncludePath.split('/')[0] !== parentId
        ) {
            console.warn('WARN: erroneous include in ', path, line);
            return;
        }

        toAllowlist[absoluteIncludePath] ??= urls.map(
            addToAllowlist(includePath),
        );
    };

    const handleDiff = (line: string) => {
        const diffPath = line.split('! Diff-Path:')[1].trim();
        const absoluteDiffPath =
            Path.join(Path.dirname(path), diffPath).split('#')[0];

        // This might happen, but it's unlikely in the wild.
        if (
            URL.canParse(absoluteDiffPath)
            || absoluteDiffPath.split('/')[0] !== parentId
        ) {
            console.warn('WARN: unsupported diff in ', path, line);
            return;
        }

        toAllowlist[absoluteDiffPath] ??= urls.map(
            addToAllowlist(diffPath),
        );
    };

    for (const line of text.split('\n')) {
        if (line.startsWith('!#include')) {
            handleInclude(line);
        } else if (line.startsWith('! Diff-Path')) {
            handleDiff(line);
        }
    }

    Allowlist.addEntries(path, toAllowlist);

    return text;
};

export const handleAssets = () => {
    return Cache.materialize(
        'assets.json',
        { type: 'application/json; charset=utf-8' },
        prepareAssetString,
    );
};

export const handleFilterlist = (path: string) => {
    if (path.startsWith('/')) {
        path = path.substring(1);
    }

    return Cache.materialize(
        path,
        { expiry_seconds: 3600 },
        () => prepareFilterlist(path),
    );
};
