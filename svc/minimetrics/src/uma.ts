import { expectWire, ProtoError, Reader, WireType } from './proto.ts';

// Field numbers from //third_party/metrics_proto in Chromium.
const CUME = {
    clientId: 1,
    systemProfile: 3,
    histogramEvent: 6,
    product: 10,
} as const;

const PROFILE = { appVersion: 2, os: 5, hardware: 6, channel: 10 } as const;
const OS = { name: 1 } as const;
const HARDWARE = { cpuArchitecture: 1 } as const;
const HISTOGRAM = { nameHash: 1, sum: 2, bucket: 3 } as const;
const BUCKET = { min: 1, max: 2, count: 4 } as const;

const MAX_HISTOGRAMS = 50_000;
const MAX_BUCKETS = 10_000;

const CHANNELS = ['unknown', 'canary', 'dev', 'beta', 'stable'] as const;

export interface Bucket {
    min: number;
    max: number;
    count: number;
}

export interface Histogram {
    /** First 8 bytes of MD5(name), as Chromium's base::HashMetricName. */
    hash: bigint;
    sum: number;
    buckets: Bucket[];
}

/** The only parts of a log that are used. Everything else (session id,
 * field trials, hardware details, ...) is dropped on parse. */
export interface UmaLog {
    /** Never stored as-is: only used to count daily users through a salted
     * hash whose salt is discarded once the day is over. 0n if missing. */
    clientId: bigint;
    product: number;
    version: string;
    channel: string;
    os: string;
    arch: string;
    histograms: Histogram[];
}

export function normalizeVersion(raw: string): string {
    return /^[0-9A-Za-z._+-]{1,40}$/.test(raw) ? raw : 'unknown';
}

export function normalizeOs(raw: string): string {
    const name = raw.toLowerCase();

    if (name.startsWith('mac')) {
        return 'macOS';
    }

    if (name.startsWith('windows')) {
        return 'Windows';
    }

    if (name === 'linux') {
        return 'Linux';
    }

    if (name === 'android') {
        return 'Android';
    }

    if (name === 'ios') {
        return 'iOS';
    }

    return raw === '' ? 'unknown' : 'other';
}

export function normalizeArch(raw: string): string {
    switch (raw.toLowerCase()) {
        case 'x86_64':
        case 'x64':
            return 'x86_64';
        case 'arm64':
        case 'aarch64':
            return 'arm64';
        case 'x86':
            return 'x86';
        case 'arm':
            return 'arm';
        case '':
            return 'unknown';
        default:
            return 'other';
    }
}

function channelName(value: number): string {
    return CHANNELS[value] ?? 'unknown';
}

interface RawBucket {
    min?: number;
    max?: number;
    count: number;
}

/** Fills in the omitted bucket fields, per histogram_event.proto:
 * a missing min is max - 1, a missing max is the next bucket's min, and a
 * missing count is 1. */
export function resolveBuckets(raw: RawBucket[]): Bucket[] {
    const mins = raw.map((b) => {
        if (b.min !== undefined) {
            return b.min;
        }

        if (b.max !== undefined) {
            return b.max - 1;
        }

        throw new ProtoError('bucket has neither min nor max');
    });

    return raw.map((b, i) => {
        let max = b.max;

        if (max === undefined) {
            if (i + 1 >= raw.length) {
                throw new ProtoError('last bucket is missing max');
            }

            max = mins[i + 1];
        }

        if (max <= mins[i]) {
            throw new ProtoError('bucket max must exceed min');
        }

        return { min: mins[i], max, count: b.count };
    });
}

function parseBucket(buf: Uint8Array): RawBucket {
    const out: RawBucket = { count: 1 };
    const r = new Reader(buf);
    r.fields((field, wire) => {
        switch (field) {
            case BUCKET.min:
                expectWire(wire, WireType.Varint, 'bucket.min');
                out.min = r.int64();

                return true;
            case BUCKET.max:
                expectWire(wire, WireType.Varint, 'bucket.max');
                out.max = r.int64();

                return true;
            case BUCKET.count:
                expectWire(wire, WireType.Varint, 'bucket.count');
                out.count = r.int64();

                return true;
        }

        return false;
    });

    if (out.count < 0) {
        throw new ProtoError('negative bucket count');
    }

    return out;
}

function parseHistogram(buf: Uint8Array): Histogram {
    let hash: bigint | undefined;
    let sum = 0;
    const raw: RawBucket[] = [];

    const r = new Reader(buf);
    r.fields((field, wire) => {
        switch (field) {
            case HISTOGRAM.nameHash:
                expectWire(wire, WireType.Fixed64, 'histogram.name_hash');
                hash = r.fixed64();

                return true;
            case HISTOGRAM.sum:
                expectWire(wire, WireType.Varint, 'histogram.sum');
                sum = r.int64();

                return true;
            case HISTOGRAM.bucket:
                expectWire(wire, WireType.Len, 'histogram.bucket');

                if (raw.length >= MAX_BUCKETS) {
                    throw new ProtoError('too many buckets');
                }

                raw.push(parseBucket(r.bytes()));

                return true;
        }

        return false;
    });

    if (hash === undefined) {
        throw new ProtoError('histogram is missing name_hash');
    }

    return { hash, sum, buckets: resolveBuckets(raw) };
}

function parseString(
    buf: Uint8Array,
    wanted: number,
    what: string,
): string | undefined {
    let out: string | undefined;
    const r = new Reader(buf);
    r.fields((field, wire) => {
        if (field !== wanted) {
            return false;
        }

        expectWire(wire, WireType.Len, what);
        out = r.string();

        return true;
    });

    return out;
}

interface Profile {
    version: string;
    channel: number;
    os: string;
    arch: string;
}

function parseSystemProfile(buf: Uint8Array, into: Profile): void {
    const r = new Reader(buf);
    r.fields((field, wire) => {
        switch (field) {
            case PROFILE.appVersion:
                expectWire(wire, WireType.Len, 'app_version');
                into.version = r.string();

                return true;
            case PROFILE.channel:
                expectWire(wire, WireType.Varint, 'channel');
                into.channel = r.int64();

                return true;
            case PROFILE.os:
                expectWire(wire, WireType.Len, 'os');
                into.os = parseString(r.bytes(), OS.name, 'os.name')
                    ?? into.os;

                return true;
            case PROFILE.hardware:
                expectWire(wire, WireType.Len, 'hardware');
                into.arch = parseString(
                    r.bytes(),
                    HARDWARE.cpuArchitecture,
                    'hardware.cpu_architecture',
                ) ?? into.arch;

                return true;
        }

        return false;
    });
}

export function parseUmaLog(buf: Uint8Array): UmaLog {
    let product = 0;
    let clientId = 0n;
    const profile: Profile = { version: '', channel: 0, os: '', arch: '' };
    const histograms: Histogram[] = [];

    const r = new Reader(buf);
    r.fields((field, wire) => {
        switch (field) {
            case CUME.clientId:
                expectWire(wire, WireType.Fixed64, 'client_id');
                clientId = r.fixed64();

                return true;
            case CUME.product:
                expectWire(wire, WireType.Varint, 'product');
                product = r.int64();

                return true;
            case CUME.systemProfile:
                expectWire(wire, WireType.Len, 'system_profile');
                parseSystemProfile(r.bytes(), profile);

                return true;
            case CUME.histogramEvent:
                expectWire(wire, WireType.Len, 'histogram_event');

                if (histograms.length >= MAX_HISTOGRAMS) {
                    throw new ProtoError('too many histograms');
                }

                histograms.push(parseHistogram(r.bytes()));

                return true;
        }

        return false;
    });

    return {
        clientId,
        product,
        version: normalizeVersion(profile.version),
        channel: channelName(profile.channel),
        os: normalizeOs(profile.os),
        arch: normalizeArch(profile.arch),
        histograms,
    };
}
