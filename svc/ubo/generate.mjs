#!/usr/bin/env node
const VERSION = '1.63.2';
const FILE_CHECKSUM = '27f60b2250e42f5bdf22fd2911d1f61542980645bffcc3cd0620256bbb56cb1b';

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

const transform = (assets) => {
    const listSources = {};

    for (const [ id, asset ] of Object.entries(assets)) {
        const allUrls = [asset.contentURL, asset.cdnURLs].flat();
        delete asset.cdnURLs;

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
        listSources[filename] = sourceURL;

        delete asset.cdnURLs;
        asset.contentURL = [
            proxyURL,
            ...locals,
        ];

        if (asset.contentURL.length === 1) {
            asset.contentURL = asset.contentURL[0];
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
            `location = /ubo/lists/${path} {`,
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
