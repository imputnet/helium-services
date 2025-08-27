import { Asset, CPUArchitecture } from './assets.ts';

export type GithubRelease = {
    tag_name: string;
    prerelease: boolean;
    draft: boolean;
    published_at: string;
    assets: {
        url: string;
        name: string;
        digest: string;
        size: number;
        browser_download_url: string;
    }[];
};

export type Version = string;

export type DownloadableMap = Record<CPUArchitecture, Asset | null>;

export type Release = {
    version: string;
    published_at: string;
    channel?: string;
    downloads: DownloadableMap;
    deltas: Record<Version, DownloadableMap>;
};
