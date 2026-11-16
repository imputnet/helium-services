import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { buildApp } from '../src/app.ts';

export function testConfig(
    dataDir: string,
    over: Partial<Config> = {},
): Config {
    return {
        port: 0,
        dataDir,
        githubClientId: 'test-client-id',
        githubClientSecret: 'test-client-secret',
        githubOrg: 'test-org',
        sessionSecret: 'test-secret-0123456789abcdef',
        namesUploadToken: 'test-names-token',
        publicBaseUrl: 'http://localhost:8080',
        maxLogSizeBytes: 1024 * 1024,
        maxNamesSizeBytes: 1024 * 1024,
        retentionDays: 90,
        rateLimitPerMinute: 6000,
        minUsers: 1,
        histogramAllowlist: null,
        ...over,
    };
}

export async function setup(over: Partial<Config> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'minimetrics-'));
    const dbPath = join(dir, 'db.sqlite');
    const config = testConfig(dir, over);
    const db = new Db(dbPath);

    const app = buildApp({
        config,
        db,
        webAuth: async (c, next) => {
            c.set('session', { login: 'tester', exp: Number.MAX_SAFE_INTEGER });
            await next();
        },
    });

    const raw = new DatabaseSync(dbPath, { readOnly: true });

    return {
        config,
        db,
        app,
        raw,
        async [Symbol.asyncDispose]() {
            raw.close();
            db.close();
            await rm(dir, { recursive: true, force: true });
        },
    };
}

export function rawRows<Row>(raw: DatabaseSync, sql: string): Row[] {
    return raw.prepare(sql).all().map((r) =>
        // SAFETY: Row lists exactly the columns the test's SQL selects.
        ({ ...r }) as Row
    );
}

// Minimal protobuf writer, enough to build ChromeUserMetricsExtension logs.
export class Writer {
    #bytes: number[] = [];

    #varint(v: bigint): void {
        let n = BigInt.asUintN(64, v);

        while (n >= 0x80n) {
            this.#bytes.push(Number(n & 0x7fn) | 0x80);
            n >>= 7n;
        }

        this.#bytes.push(Number(n));
    }

    #tag(field: number, wire: number): void {
        this.#varint(BigInt((field << 3) | wire));
    }

    int(field: number, v: number | bigint): this {
        this.#tag(field, 0);
        this.#varint(BigInt(v));

        return this;
    }

    fixed64(field: number, v: bigint): this {
        this.#tag(field, 1);
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), true);
        this.#bytes.push(...b);

        return this;
    }

    bytes(field: number, v: Uint8Array): this {
        this.#tag(field, 2);
        this.#varint(BigInt(v.byteLength));
        this.#bytes.push(...v);

        return this;
    }

    string(field: number, v: string): this {
        return this.bytes(field, new TextEncoder().encode(v));
    }

    message(field: number, fn: (w: Writer) => void): this {
        const w = new Writer();
        fn(w);

        return this.bytes(field, w.finish());
    }

    finish(): Uint8Array<ArrayBuffer> {
        return new Uint8Array(this.#bytes);
    }
}

export interface TestHistogram {
    hash: bigint;
    sum?: number;
    buckets: { min?: number; max?: number; count?: number }[];
}

export interface TestLog {
    clientId?: bigint;
    version?: string;
    channel?: number;
    os?: string;
    arch?: string;
    histograms?: TestHistogram[];
}

export function encodeLog(log: TestLog): Uint8Array<ArrayBuffer> {
    const w = new Writer();

    if (log.clientId !== undefined) {
        w.fixed64(1, log.clientId);
    }

    w.int(2, 7); // session_id, ignored
    w.message(3, (p) => {
        p.int(1, 1_700_000_000); // build_timestamp, ignored
        p.string(2, log.version ?? '142.0.7444.1-64');
        p.string(4, 'en-US'); // application_locale, ignored
        p.message(
            5,
            (os) => os.string(1, log.os ?? 'Mac OS X').string(2, '26.1'),
        );
        p.message(6, (hw) => hw.string(1, log.arch ?? 'arm64').int(2, 16384));
        p.int(10, log.channel ?? 4);
    });

    for (const h of log.histograms ?? []) {
        w.message(6, (hw) => {
            hw.fixed64(1, h.hash);

            if (h.sum) {
                hw.int(2, h.sum);
            }

            for (const b of h.buckets) {
                hw.message(3, (bw) => {
                    if (b.min !== undefined) bw.int(1, b.min);

                    if (b.max !== undefined) bw.int(2, b.max);

                    if (b.count !== undefined) bw.int(4, b.count);
                });
            }
        });
    }

    w.int(10, 0); // product

    return w.finish();
}

export async function gzip(data: Uint8Array<ArrayBuffer>) {
    const stream = new Blob([data]).stream().pipeThrough(
        new CompressionStream('gzip'),
    );

    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha1Hex(data: Uint8Array<ArrayBuffer>) {
    const digest = await crypto.subtle.digest('SHA-1', data);

    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Builds an upload request the way Chromium's NetMetricsLogUploader does. */
export async function umaRequest(
    log: Uint8Array<ArrayBuffer>,
    headers: Record<string, string> = {},
) {
    return new Request('http://localhost/uma/v2', {
        method: 'POST',
        headers: {
            'content-type': 'application/vnd.chrome.uma',
            'content-encoding': 'gzip',
            'x-chrome-uma-log-sha1': (await sha1Hex(log)).toUpperCase(),
            'x-chrome-uma-log-hmac-sha256': 'ignored',
            'x-forwarded-for': '192.0.2.1',
            ...headers,
        },
        body: await gzip(log),
    });
}

export const FCP = 0x8559fe6630fce9a7n;
export const MEMORY = 0x3bcbd964bd863ac3n;
