export type CPUArchitecture = 'arm64' | 'x86_64';

export type Asset = {
    name: string;
    machine_url: string;
    user_facing_url: string;
    digest: string;
    size: number;
};
