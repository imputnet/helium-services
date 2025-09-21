#!/usr/bin/env node
const VERSION = '1.66.4';
const FILE_CHECKSUM = 'e29f49f1b565119988961671c6daefb0e90ac5b7a2ebf54e64c5bfc313030fef';

const originalAssetURL = `https://raw.githubusercontent.com/gorhill/uBlock/refs/tags/${VERSION}/assets/assets.json`;

const digest = async (str) => {
    const u8 = new TextEncoder().encode(str);
    const hashBytes = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(hashBytes)]
            .map(a => a.toString(16).padStart(2, '0'))
            .join('');
}

const isUrl = (str) => {
    try {
        return new URL(str).protocol.startsWith('http');
    } catch {
        return false;
    }
}

const load = async () => {
    const assetList = await fetch(originalAssetURL).then(a => a.text());
    if (await digest(assetList) !== FILE_CHECKSUM) {
        throw `checksum does not match: ${await digest(assetList)}`;
    }

    return JSON.parse(assetList);
}

const transform = async (assets) => {
    const listSources = {}, queue = [];

    const readList = async (filename, sourceURL) => {
        if (listSources[filename]) {
            throw "duplicate source key: " + filename;
        }

        const res = await fetch(sourceURL, { redirect: 'follow' });
        listSources[filename] = res.url;

        if (res.ok) {
            return [ res.url, res.text() ];
        }

        throw new Error(res);
    }

    for (const [ id, asset ] of Object.entries(assets)) {
        const allUrls = [asset.contentURL, asset.cdnURLs].flat();

        delete asset.cdnURLs;
        delete asset.patchURLs;

        if (id === 'assets.json') {
            asset.contentURL = `https://{{ services_hostname }}/ubo/assets.json`;
            continue;
        }

        const sourceURL = allUrls.find(isUrl);
        const locals = allUrls.filter(u => u?.startsWith('assets/'));

        if (!sourceURL) {
            throw `no source for ${asset.title}`;
        }

        const filename = id.includes('.') ? id : `${id}.txt`;
        const proxyURL = `https://{{ services_hostname }}/ubo/lists/${filename}`;

        asset.contentURL = [
            proxyURL,
            ...locals,
        ];

        const contents = readList(filename, sourceURL);
        queue.push(contents);

        if (asset.contentURL.length === 1) {
            asset.contentURL = asset.contentURL[0];
        }
    }

    while (queue.length) {
        const listContents = await Promise.all(queue);
        queue.length = 0;

        for (const [ base_str, contents ] of listContents) {
            const base = new URL(base_str);
            const text = await contents;

            text.split('\n')
                .filter(a => a.startsWith('!#include'))
                .forEach(importLine => {
                    const url = new URL(importLine.replace('!#include ', ''), base);
                    if (url.origin !== base.origin) {
                        throw `origin mismatch: ${url.origin} != ${base.origin}`;
                    }

                    const base_base = base.pathname.split('/').slice(0, -1).join('/');
                    if (!url.pathname.startsWith(base_base)) {
                        throw `invalid base: ${url.pathname} !starts_with(${base_base})`;
                    }

                    const filename = url.pathname.replace(base_base, '').replace(/^\//, '');
                    queue.push(readList(filename, url.toString()));
                })
        }
    }

    return { assets, listSources };
}

const toNginxConfig = (listSources) => {
    let out = [];

    const sortedSources = Object.entries(listSources).sort(
        (a, b) => a[0].localeCompare(b[0])
    );

    for (const [ path, url ] of sortedSources) {
        out.push(
            `location = ${JSON.stringify(`/ubo/lists/${decodeURIComponent(path)}`)} {`,
            `   limit_except GET { deny all; }`,
            `   proxy_pass ${JSON.stringify(url)};`,
            `}\n`,
        );
    }

    return out.join('\n');
}

load().then(transform).then(async ({ assets, listSources }) => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const out = filename => join(import.meta.dirname, 'gen', filename);

    return await Promise.all([
        writeFile(
            out('assets.json.j2'),
            JSON.stringify(assets, null, 2),
        ),
        writeFile(
            out('nginx-ubo-lists.conf'),
            toNginxConfig(listSources),
        ),
    ]);
});
