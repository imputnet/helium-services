import type { App, OmahaResponseAppBase, OmahaResponseInnerBase } from '../types.ts';
import * as Util from '../../util.ts';

import { REQUEST_TEMPLATE } from './constants.ts';

export type UpdateCheck = {
    rollback_allowed?: boolean;
    sameversionupdate?: boolean;
    targetversionprefix?: string;
    updatedisabled?: boolean;
};

export type AppInternal = App & {
    enabled: boolean;
    installedby: string;
    installsource: string;
    lang: string;
    packages: {
        package: { fp: string }[];
    };
    ping: { r: -1 };
    updatecheck: UpdateCheck;
};

export type OmahaRequest = Omit<Util.DeepWritable<typeof REQUEST_TEMPLATE>, 'app'> & {
    app: AppInternal[];
};

export type OmahaResponseApp = OmahaResponseAppBase & {
    cohorthint: string;
    updatecheck?:
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

export type OmahaResponseInner = OmahaResponseInnerBase & {
    protocol: '3.0' | '3.1';
    app?: OmahaResponseApp[];
};

export type OmahaResponse = {
    response: OmahaResponseInner;
};
