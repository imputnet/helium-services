import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { dbPath, ensureDataDirs } from '../src/paths.ts';
import { encodeSession } from '../src/session.ts';
import { serializeSigned } from 'hono/utils/cookie';
import {
    BlobWriter,
    TextReader,
    Uint8ArrayReader,
    ZipWriter,
} from '@zip.js/zip.js';

export function testConfig(
    dataDir: string,
    over: Partial<Config> = {},
): Config {
    return {
        port: 0,
        dataDir,
        symbolicatorUrl: 'http://127.0.0.1:1',
        githubClientId: 'test-client-id',
        githubClientSecret: 'test-client-secret',
        githubOrg: 'test-org',
        githubIssueRepo: null,
        githubIssueTemplate: null,
        sessionSecret: 'test-secret-0123456789abcdef',
        symbolUploadToken: 'test-upload-token',
        maxDumpSizeBytes: 20 * 1024 * 1024,
        retentionDays: 30,
        symbolsRetentionDays: 180,
        publicBaseUrl: 'http://localhost:8080',
        signatureFrames: 5,
        maxAttempts: 5,
        workerPollMs: 25,
        rateLimitPerMinute: 6000,
        githubArtifactToken: null,
        artifactCrawlerPollMs: 15 * 60 * 1000,
        artifactCrawlerMaxBytes: 20 * 1024 * 1024 * 1024,
        artifactCrawlerMaxAgeDays: 7,
        artifactCrawlerNamePattern: String.raw`(?:^|[-_.])(symbols?|symbolicated|debug(?:-?symbols?)?|dsym|pdb)(?:$|[-_.])`,
        ...over,
    };
}

export function minimalMinidump(): Uint8Array {
    const dump = new Uint8Array(32);
    dump.set([0x4d, 0x44, 0x4d, 0x50]);
    return dump;
}

/** Re-stream bytes in small chunks so parsers cannot rely on chunk boundaries. */
export function chunked(
    bytes: Uint8Array,
    size: number,
): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({
        pull(controller) {
            if (offset >= bytes.byteLength) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(offset, offset + size));
            offset += size;
        },
    });
}

export function makeTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'minidumpster-test-'));
}

export async function makeZip(
    entries: [string, Uint8Array | string][],
    level?: number,
): Promise<Uint8Array> {
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    for (const [name, data] of entries) {
        await writer.add(
            name,
            typeof data === 'string'
                ? new TextReader(data)
                : new Uint8ArrayReader(data),
            level === undefined ? {} : { level },
        );
    }
    return new Uint8Array(await (await writer.close()).arrayBuffer());
}

export async function testSessionCookie(env: TestEnv): Promise<string> {
    const now = Date.now();
    const value = encodeSession({
        login: 'jj',
        exp: now + 60_000,
    });
    const cookie = await serializeSigned(
        'session',
        value,
        env.config.sessionSecret,
    );
    return cookie.split(';')[0];
}

export interface TestEnv {
    dir: string;
    config: Config;
    db: Db;
    cleanup(): Promise<void>;
}

export async function makeTestEnv(
    over: Partial<Config> = {},
): Promise<TestEnv> {
    const dir = await makeTempDir();
    await ensureDataDirs(dir);
    const config = testConfig(dir, over);
    const db = new Db(dbPath(dir));
    return {
        dir,
        config,
        db,
        async cleanup() {
            db.close();
            await rm(dir, { recursive: true }).catch(() => {});
        },
    };
}

export async function gzipBytes(
    data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
    const stream = new Response(data.slice()).body!.pipeThrough(
        new CompressionStream('gzip'),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Serialize a FormData into raw multipart bytes plus its content-type header. */
export async function encodeMultipart(
    form: FormData,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
    const req = new Request('http://encode.local/', {
        method: 'POST',
        body: form,
    });
    const bytes = new Uint8Array(await req.arrayBuffer());
    return { bytes, contentType: req.headers.get('content-type')! };
}

export function fixtureResponse(): Promise<string> {
    return readFile(
        new URL('./fixtures/symbolicator_completed.json', import.meta.url),
        'utf8',
    );
}

export function appleCrashFixture(): Promise<string> {
    return readFile(
        new URL('./fixtures/apple_report.txt', import.meta.url),
        'utf8',
    );
}

export function appleFixtureResponse(): Promise<string> {
    return readFile(
        new URL(
            './fixtures/symbolicator_apple_completed.json',
            import.meta.url,
        ),
        'utf8',
    );
}
