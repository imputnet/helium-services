#!/usr/bin/env node
const VERSION = '1.65.0';
const FILE_CHECKSUM = '5f35d1c6cf09d7231069b8cb15a577face574c89f8691585ae961c1495b31d1e';

const originalAssetURL = `https://raw.githubusercontent.com/gorhill/uBlock/refs/tags/${VERSION}/assets/assets.json`;
const crxURL = `https://github.com/imputnet/ublock-origin-crx/releases/download/${VERSION}/uBlock0_${VERSION}.crx`;

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
        const res = await fetch(sourceURL, { redirect: 'follow' });
        if (listSources[filename]) {
            throw "duplicate source key: " + filename;
        }

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

const generateUpdateManifest = () => {
    return [
        "<?xml version='1.0' encoding='UTF-8'?>",
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>",
        "    <app appid='blockjmkbacgjkknlgpkjjiijinjdanf'>",
        "        <updatecheck codebase='https://{{ services_hostname }}/ubo/ublock.crx' version='" + VERSION + "' />",
        "    </app>",
        "</gupdate>"
    ].join('\n')
}

const generateCRXDownloadInfo = async () => {
    const response = await fetch(
        `https://api.github.com/repos/imputnet/ublock-origin-crx/releases/tags/${VERSION}`
    ).then(a => {
        if (!a.ok) throw a;
        return a.json();
    });

    const sha256sum = response.body.split('```\n')[1].split(' ')[0];
    if (sha256sum.length !== 64) throw "invalid checksum";
    console.log(`sha256(crx) = ${sha256sum}`);

    return [
        crxURL,
        `${sha256sum} /usr/share/ublock/ubo/ublock.crx`
    ].join('\n');
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
        writeFile(
            out('update.xml.j2'),
            generateUpdateManifest(),
        ),
        writeFile(
            out('crx_info.txt'),
            await generateCRXDownloadInfo(),
        ),
    ]);
});
