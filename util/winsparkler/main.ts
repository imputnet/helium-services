type GithubAsset = {
    name: string;
    browser_download_url: string;
    size: number;
    digest?: string;
};

type GithubRelease = {
    draft: boolean;
    prerelease: boolean;
    tag_name: string;
    html_url: string;
    published_at: string;
    assets: GithubAsset[];
};

type Arch = 'x64' | 'arm64';

type Release = {
    version: string;
    releaseNotesUrl: string;
    publishedAt: string;
    assets: Record<Arch, GithubAsset | null>;
};

const strictGet = (name: string) => {
    const value = Deno.env.get(name);
    if (!value) {
        throw new Error(`env ${name} is missing`);
    }
    return value;
};

const getBool = (name: string, fallback = false) => {
    const value = Deno.env.get(name);
    if (!value) {
        return fallback;
    }
    return ['1', 'true', 'yes'].includes(value.toLowerCase());
};

const env = {
    githubRepo: Deno.env.get('GITHUB_REPO') ?? 'imputnet/helium-windows',
    githubAccessToken: Deno.env.get('GITHUB_ACCESS_TOKEN'),
    outputDir: strictGet('OUTPUT_DIR'),
    assetsDir: strictGet('ASSETS_DIR'),
    serveAssetsLocally: getBool('SERVE_ASSETS_LOCALLY', true),
};

const headers: Record<string, string> = {};
if (env.githubAccessToken) {
    headers['authorization'] = `Bearer ${env.githubAccessToken}`;
}

const appcastPathFor = (arch: Arch) => `${env.outputDir}/appcast-${arch}.xml`;
const assetPathFor = (asset: GithubAsset) => `${env.assetsDir}/${asset.name}`;
const githubRepoUrl = `https://github.com/${env.githubRepo}`;

const escapeXml = (value: string) => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const assetUrlFor = (asset: GithubAsset) => env.serveAssetsLocally
    ? `assets/${asset.name}`
    : asset.browser_download_url;

const sha256 = async (data: Uint8Array) => {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
};

const isValidReleaseUrl = (url: string) =>
    url.startsWith(`${githubRepoUrl}/releases/`);

const isValidAssetUrl = (url: string) =>
    url.startsWith(`${githubRepoUrl}/releases/download/`);

const getArchFromName = (name: string): Arch | null => {
    if (/_x64-installer\.exe$/i.test(name)) {
        return 'x64';
    }
    if (/_arm64-installer\.exe$/i.test(name)) {
        return 'arm64';
    }
    return null;
};

const fetchJson = async <T>(url: string): Promise<T> => {
    const response = await fetch(url, {
        headers: {
            ...headers,
            accept: 'application/vnd.github+json',
        },
    });

    if (!response.ok) {
        throw new Error(`request failed (${response.status}): ${url}`);
    }

    return await response.json() as T;
};

const getReleases = async (): Promise<Release[]> => {
    const githubReleases = await fetchJson<GithubRelease[]>(
        `https://api.github.com/repos/${env.githubRepo}/releases?per_page=20`,
    );

    return githubReleases
        .filter((release) => !release.draft && !release.prerelease)
        .map((release) => {
            if (!isValidReleaseUrl(release.html_url)) {
                throw new Error(`invalid release url: ${release.html_url}`);
            }

            return {
                version: release.tag_name,
                releaseNotesUrl: release.html_url,
                publishedAt: release.published_at,
                assets: release.assets.reduce<Record<Arch, GithubAsset | null>>((acc, asset) => {
                    if (!isValidAssetUrl(asset.browser_download_url)) {
                        return acc;
                    }

                    const arch = getArchFromName(asset.name);
                    if (arch) {
                        acc[arch] = asset;
                    }
                    return acc;
                }, { x64: null, arm64: null }),
            };
        })
        .filter((release) => release.assets.x64 || release.assets.arm64);
};

const downloadAsset = async (asset: GithubAsset) => {
    const response = await fetch(asset.browser_download_url, { headers });
    if (!response.ok) {
        throw new Error(`asset download failed (${response.status}): ${asset.name}`);
    }

    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== asset.size) {
        throw new Error(`size mismatch for ${asset.name}: expected ${asset.size}, got ${data.length}`);
    }

    const expectedDigest = asset.digest?.replace('sha256:', '');
    if (expectedDigest) {
        const actualDigest = await sha256(data);
        if (actualDigest !== expectedDigest) {
            throw new Error(`digest mismatch for ${asset.name}`);
        }
    }

    await Deno.mkdir(env.assetsDir, { recursive: true });
    await Deno.writeFile(assetPathFor(asset), data);
};

const ensureAssets = async (releases: Release[]) => {
    if (!env.serveAssetsLocally) {
        return;
    }

    const requiredAssets = releases.flatMap((release) =>
        [release.assets.x64, release.assets.arm64].filter(
            (asset): asset is GithubAsset => asset !== null,
        ));

    const requiredNames = new Set(requiredAssets.map((asset) => asset.name));
    await Deno.mkdir(env.assetsDir, { recursive: true });

    for await (const entry of Deno.readDir(env.assetsDir)) {
        if (entry.isFile && !requiredNames.has(entry.name)) {
            await Deno.remove(`${env.assetsDir}/${entry.name}`);
        }
    }

    for (const asset of requiredAssets) {
        try {
            await Deno.stat(assetPathFor(asset));
        } catch {
            console.log(`downloading ${asset.name}`);
            await downloadAsset(asset);
        }
    }
};

const makeItemXml = (release: Release, arch: Arch) => {
    const asset = release.assets[arch];
    if (!asset) {
        return null;
    }

    return [
        '    <item>',
        `      <title>${escapeXml(release.version)}</title>`,
        `      <pubDate>${new Date(release.publishedAt).toUTCString()}</pubDate>`,
        `      <sparkle:version>${escapeXml(release.version)}</sparkle:version>`,
        `      <sparkle:shortVersionString>${escapeXml(release.version)}</sparkle:shortVersionString>`,
        '      <sparkle:minimumSystemVersion>10.0</sparkle:minimumSystemVersion>',
        `      <sparkle:releaseNotesLink>${escapeXml(release.releaseNotesUrl)}</sparkle:releaseNotesLink>`,
        `      <enclosure url="${escapeXml(assetUrlFor(asset))}" length="${asset.size}" type="application/octet-stream"/>`,
        '    </item>',
    ].join('\n');
};

const renderAppcast = (releases: Release[], arch: Arch) => {
    const items = releases
        .map((release) => makeItemXml(release, arch))
        .filter((item): item is string => item !== null)
        .join('\n');

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">',
        '  <channel>',
        `    <title>Helium Windows (${arch})</title>`,
        '    <description>Stable Helium for Windows updates</description>',
        '    <language>en</language>',
        items,
        '  </channel>',
        '</rss>',
        '',
    ].join('\n');
};

if (import.meta.main) {
    const releases = await getReleases();
    await ensureAssets(releases);
    await Deno.mkdir(env.outputDir, { recursive: true });

    for (const arch of ['x64', 'arm64'] as const) {
        await Deno.writeTextFile(appcastPathFor(arch), renderAppcast(releases, arch));
    }
}
