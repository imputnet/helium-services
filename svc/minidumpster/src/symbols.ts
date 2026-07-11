import { join } from '@std/path';

import { logEvent } from './log.ts';
import { extractZip } from './zip.ts';
import { HttpError } from './crash.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { symbolsDir, tmpDir } from './paths.ts';
import { streamMultipartToDisk } from './multipart.ts';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface SymbolIngestResult {
    ok: true;
    product: string;
    version: string;
    filesExtracted: number;
    debugIds: string[];
    output: string;
}

export interface SymbolIngestAndRequeueResult extends SymbolIngestResult {
    requeued: number;
}

export interface SymbolsOptions {
    symsorterBin?: string;
}

// Must outlast caches.downloaded.retry_misses_after in symbolicator.config.yml,
// or requeued reports would just be served the cached misses again.
const SYMBOLS_REQUEUE_DELAY_MS = 10 * 60 * 1000;

function bearerToken(req: Request): string | null {
    const h = req.headers.get('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);

    return m ? m[1].trim() : null;
}

async function streamToFile(
    stream: ReadableStream<Uint8Array>,
    path: string,
): Promise<number> {
    const f = await Deno.open(path, {
        write: true,
        create: true,
        truncate: true,
    });

    let size = 0;
    try {
        for await (const chunk of stream) {
            let off = 0;
            while (off < chunk.length) {
                off += await f.write(chunk.subarray(off));
            }
            size += chunk.length;
        }
    } finally {
        f.close();
    }

    return size;
}

async function runSymsorter(
    bin: string,
    args: string[],
): Promise<{ code: number; output: string }> {
    const proc = new Deno.Command(bin, {
        args,
        stdout: 'piped',
        stderr: 'piped',
    });

    const res = await proc.output();
    const output = new TextDecoder().decode(res.stdout)
        + new TextDecoder().decode(res.stderr);

    return { code: res.code, output };
}

async function sortSymbolDirectory(
    inputDir: string,
    product: string,
    version: string,
    filesExtracted: number,
    config: Config,
    opts: SymbolsOptions,
    sourceBytes?: number,
): Promise<SymbolIngestResult> {
    if (!NAME_RE.test(product) || !NAME_RE.test(version)) {
        throw new HttpError(400, 'invalid symbol product or version');
    }

    logEvent('symbols_extracted', {
        product,
        version,
        files: filesExtracted,
    });

    const bin = opts.symsorterBin ?? 'symsorter';

    // No --prefix: Symbolicator's unified-layout lookup is exactly
    // <id[:2]>/<id[2:]>/<type> relative to the source root, so a product
    // prefix directory would make every lookup miss. Debug IDs are globally
    // unique. The bundle id tags this upload for retention bookkeeping.
    const sorted = await runSymsorter(bin, [
        '--output',
        symbolsDir(config.dataDir),
        '--bundle-id',
        `${product}-${version}`,
        inputDir,
    ]).catch(() => {
        throw new HttpError(500, 'symsorter is not installed on the server');
    });
    if (sorted.code !== 0) {
        throw new HttpError(
            500,
            `symsorter failed: ${sorted.output.slice(0, 1000)}`,
        );
    }

    const debugIds = [
        ...new Set(sorted.output.match(/\b[0-9a-fA-F]{32,40}\b/g) ?? []),
    ];

    logEvent('symbols_ingested', {
        product,
        version,
        files_extracted: filesExtracted,
        debug_ids: debugIds.length,
        source_bytes: sourceBytes,
    });

    return {
        ok: true,
        product,
        version,
        filesExtracted,
        debugIds,
        output: sorted.output.trim(),
    };
}

async function processSymbolZip(
    zipPath: string,
    workDir: string,
    product: string,
    version: string,
    config: Config,
    opts: SymbolsOptions,
): Promise<SymbolIngestResult> {
    if (!NAME_RE.test(product)) {
        throw new HttpError(
            400,
            "missing or invalid 'product' (query param or multipart field)",
        );
    }
    if (!NAME_RE.test(version)) {
        throw new HttpError(
            400,
            "missing or invalid 'version' (query param or multipart field)",
        );
    }

    const stat = await Deno.stat(zipPath).catch(() => null);
    if (!stat || stat.size === 0) {
        throw new HttpError(400, 'empty upload');
    }

    logEvent('symbols_upload_spooled', {
        product,
        version,
        zip_bytes: stat.size,
    });

    const extractDir = join(workDir, 'extracted');
    await Deno.mkdir(extractDir);

    let filesExtracted: number;
    try {
        filesExtracted = await extractZip(zipPath, extractDir);
    } catch (e) {
        throw new HttpError(
            400,
            `not a valid zip archive: ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
    }
    if (filesExtracted === 0) {
        throw new HttpError(400, 'zip archive contains no files');
    }

    return await sortSymbolDirectory(
        extractDir,
        product,
        version,
        filesExtracted,
        config,
        opts,
        stat.size,
    );
}

export async function handleSymbolUpload(
    req: Request,
    config: Config,
    opts: SymbolsOptions = {},
): Promise<SymbolIngestResult> {
    if (bearerToken(req) !== config.symbolUploadToken) {
        throw new HttpError(401, 'missing or invalid bearer token');
    }
    if (!req.body) {
        throw new HttpError(400, 'empty request body');
    }

    const url = new URL(req.url);
    let product = url.searchParams.get('product') ?? '';
    let version = url.searchParams.get('version') ?? '';

    await Deno.mkdir(tmpDir(config.dataDir), { recursive: true });
    const workDir = await Deno.makeTempDir({
        dir: tmpDir(config.dataDir),
        prefix: 'symbols-',
    });
    const zipPath = join(workDir, 'upload.zip');

    logEvent('symbols_upload_started', {
        product,
        version,
        content_length: req.headers.get('content-length'),
    });

    try {
        const contentType = req.headers.get('content-type') ?? '';
        if (contentType.toLowerCase().includes('multipart/form-data')) {
            const parsed = await streamMultipartToDisk(
                req.body,
                contentType,
                () => zipPath,
            ).catch((e) => {
                throw new HttpError(
                    400,
                    e instanceof Error ? e.message : 'malformed multipart body',
                );
            });

            product = parsed.fields['product'] || product;
            version = parsed.fields['version'] || version;
            if (parsed.files.length === 0) {
                throw new HttpError(400, 'no file part in multipart body');
            }
        } else {
            await streamToFile(req.body, zipPath);
        }

        return await processSymbolZip(
            zipPath,
            workDir,
            product,
            version,
            config,
            opts,
        );
    } finally {
        await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
}

function requeueSymbolResult(
    result: SymbolIngestResult,
    db: Db,
): SymbolIngestAndRequeueResult {
    const requeued = db.requeueUnsymbolicated(
        result.product,
        result.version,
        Date.now() + SYMBOLS_REQUEUE_DELAY_MS,
    );
    if (requeued > 0) {
        logEvent('symbols_requeue', {
            product: result.product,
            version: result.version,
            requeued,
        });
    }
    return { ...result, requeued };
}

export async function ingestSymbolDirectory(
    inputDir: string,
    product: string,
    version: string,
    filesExtracted: number,
    config: Config,
    db: Db,
    opts: SymbolsOptions = {},
): Promise<SymbolIngestAndRequeueResult> {
    if (filesExtracted < 1) {
        throw new HttpError(400, 'artifact contains no matching symbol files');
    }
    const result = await sortSymbolDirectory(
        inputDir,
        product,
        version,
        filesExtracted,
        config,
        opts,
    );
    return requeueSymbolResult(result, db);
}

export async function ingestSymbolArchive(
    body: ReadableStream<Uint8Array>,
    product: string,
    version: string,
    config: Config,
    db: Db,
    opts: SymbolsOptions = {},
): Promise<SymbolIngestAndRequeueResult> {
    await Deno.mkdir(tmpDir(config.dataDir), { recursive: true });
    const workDir = await Deno.makeTempDir({
        dir: tmpDir(config.dataDir),
        prefix: 'symbols-',
    });
    const zipPath = join(workDir, 'upload.zip');
    logEvent('symbols_upload_started', {
        product,
        version,
        source: 'artifact_crawler',
    });

    try {
        await streamToFile(body, zipPath);
        const result = await processSymbolZip(
            zipPath,
            workDir,
            product,
            version,
            config,
            opts,
        );
        return requeueSymbolResult(result, db);
    } finally {
        await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
}

export async function ingestSymbolUpload(
    req: Request,
    config: Config,
    db: Db,
    opts: SymbolsOptions = {},
): Promise<SymbolIngestAndRequeueResult> {
    const result = await handleSymbolUpload(req, config, opts);
    return requeueSymbolResult(result, db);
}
