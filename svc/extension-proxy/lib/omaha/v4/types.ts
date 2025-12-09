import type { App, OmahaResponseAppBase, OmahaResponseInnerBase } from '../types.ts';
import { REQUEST_TEMPLATE } from './constants.ts';
import * as Util from '../../util.ts';

export type UpdateCheck = {
    cause?: '' | 'ondemand' | 'scheduled';
    rollback_allowed?: boolean;
    targetversionprefix?: string;
    updatedisabled?: boolean;
};

export type AppInternal = App & {
    enabled: boolean;
    installsource: string;
    lang: string;
    ping: { r: -2 };
    updatecheck: UpdateCheck;
};

export type OmahaRequest = Omit<Util.DeepWritable<typeof REQUEST_TEMPLATE>, 'apps'> & {
    apps: AppInternal[];
};

export type OmahaV4PipelineOperation =
    | {
        type: 'download';
        size?: number;
        out?: {
            sha256?: string;
        };
        urls?: {
            url?: string;
        }[];
    }
    | { type: 'crx3'; in?: { sha256?: string } };

export type OmahaResponseApp = OmahaResponseAppBase & {
    updatecheck:
        | { status: 'noupdate' }
        | {
            status: 'ok';
            nextversion: string;
            pipelines: {
                pipeline_id: string;
                operations: OmahaV4PipelineOperation[];
            }[];
        };
};

export type OmahaResponseInner = OmahaResponseInnerBase & {
    protocol: '4.0';
    apps?: OmahaResponseApp[];
};

export type OmahaResponse = {
    response: OmahaResponseInner;
};
