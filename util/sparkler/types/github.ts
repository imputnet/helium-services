import type { Asset, CPUArchitecture } from './assets.ts';

export type { GithubRelease } from '@helium-services/common/github';

export type Version = string;

export type DownloadableMap = Record<CPUArchitecture, Asset | null>;

export type Release = {
    version: string;
    published_at: string;
    channel?: string;
    downloads: DownloadableMap;
    deltas: Record<Version, DownloadableMap>;
};
