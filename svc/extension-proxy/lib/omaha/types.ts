import * as V3 from './v3/index.ts';
import * as V4 from './v4/index.ts';
import { UPDATE_SERVICES } from './constants.ts';

export type App = {
    appid: string;
    version: string;
    brand?: string;
    updatecheck?: V3.UpdateCheck | V4.UpdateCheck;
};

export type OmahaResponseAppBase = {
    appid: string;
    status?: string;
    cohort: string;
    cohortname: string;
    ping: { status: string };
};

export type OmahaResponseInnerBase = {
    server: string;
    daystart: {
        elapsed_seconds: number;
        elapsed_days: number;
    };
};

export type ResponseType = 'json' | 'xml' | 'redirect';
export type ServiceId = keyof typeof UPDATE_SERVICES;
export type ProtocolVersion = 3 | 4;

export type OmahaRequest = V3.OmahaRequest | V4.OmahaRequest;
export type OmahaResponse = V3.OmahaResponse | V4.OmahaResponse;
