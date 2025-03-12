type OmahaResponseApp = {
    appid: string;
    cohort: string;
    cohortname: string;
    cohorthint: string;
    ping: { status: string };
    updatecheck:
        | { status: 'noupdate' }
        | {
            status: 'ok';
            urls: {
                url: ({ codebase: string } | { codebasediff: string })[];
            };
            manifest: {
                version: string;
                packages: {
                    package: {
                        hash_sha256: string;
                        size: number;
                        name: string;
                        fp: string;
                        required: boolean;
                    }[];
                };
            };
        };
};

type OmahaResponseInner = {
    server: string;
    protocol: string;
    daystart: {
        elapsed_seconds: number;
        elapsed_days: number;
    };
    app?: OmahaResponseApp[];
};

export type OmahaResponse = { response: OmahaResponseInner };
