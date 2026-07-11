import type { Config } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { dbPath, ensureDataDirs } from '../src/paths.ts';

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
        artifactCrawlerNamePattern: String
            .raw`(?:^|[-_.])(symbols?|symbolicated|debug(?:-?symbols?)?|dsym|pdb)(?:$|[-_.])`,
        ...over,
    };
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
    const dir = await Deno.makeTempDir({ prefix: 'minidumpster-test-' });
    await ensureDataDirs(dir);
    const config = testConfig(dir, over);
    const db = new Db(dbPath(dir));
    return {
        dir,
        config,
        db,
        async cleanup() {
            db.close();
            await Deno.remove(dir, { recursive: true }).catch(() => {});
        },
    };
}

export async function gzipBytes(
    data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
    const stream = new Response(data.slice()).body!.pipeThrough(
        new CompressionStream('gzip') as unknown as TransformStream<
            Uint8Array,
            Uint8Array
        >,
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
    return Deno.readTextFile(
        new URL('./fixtures/symbolicator_completed.json', import.meta.url),
    );
}
