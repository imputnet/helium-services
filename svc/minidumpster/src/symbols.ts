import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { logEvent } from './log.ts';
import { extractZip } from './zip.ts';
import { HttpError } from './crash.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { isNotFound, symbolsDir, tmpDir } from './paths.ts';
import { streamMultipartToDisk } from './multipart.ts';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SYMSORTER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface SymbolIngestResult {
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

function requireValidNames(product: string, version: string): void {
    for (const [field, value] of [
        ['product', product],
        ['version', version],
    ]) {
        if (!NAME_RE.test(value)) {
            throw new HttpError(
                400,
                `missing or invalid '${field}' (query param or multipart field)`,
            );
        }
    }
}

async function runSymsorter(
    bin: string,
    args: string[],
    timeoutMs: number,
): Promise<{ code: number; output: string }> {
    const proc = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    const [code] = await once(proc, 'close');
    if (proc.killed) {
        throw new Error(`symsorter exceeded timeout of ${timeoutMs}ms`);
    }
    return {
        code: code ?? 1,
        output:
            Buffer.concat(stdout).toString() + Buffer.concat(stderr).toString(),
    };
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
    let sorted: { code: number; output: string };
    try {
        sorted = await runSymsorter(
            bin,
            [
                '--output',
                symbolsDir(config.dataDir),
                '--bundle-id',
                `${product}-${version}`,
                inputDir,
            ],
            SYMSORTER_TIMEOUT_MS,
        );
    } catch (err) {
        if (isNotFound(err)) {
            throw new HttpError(
                500,
                'symsorter is not installed on the server',
            );
        }
        throw err;
    }
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
    requireValidNames(product, version);

    const zipStat = await stat(zipPath).catch(() => null);
    if (!zipStat || zipStat.size === 0) {
        throw new HttpError(400, 'empty upload');
    }

    logEvent('symbols_upload_spooled', {
        product,
        version,
        zip_bytes: zipStat.size,
    });

    const extractDir = join(workDir, 'extracted');
    await mkdir(extractDir, { mode: 0o700 });

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

    return sortSymbolDirectory(
        extractDir,
        product,
        version,
        filesExtracted,
        config,
        opts,
        zipStat.size,
    );
}

async function handleSymbolUpload(
    req: Request,
    config: Config,
    opts: SymbolsOptions,
): Promise<SymbolIngestResult> {
    const body = req.body;
    if (!body) {
        throw new HttpError(400, 'empty request body');
    }

    const url = new URL(req.url);
    let product = url.searchParams.get('product') ?? '';
    let version = url.searchParams.get('version') ?? '';

    await mkdir(tmpDir(config.dataDir), { recursive: true });
    const workDir = await mkdtemp(join(tmpDir(config.dataDir), 'symbols-'));
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
                body,
                contentType,
                () => zipPath,
            ).catch((e) => {
                const message =
                    e instanceof Error ? e.message : 'malformed multipart body';
                throw new HttpError(400, message);
            });

            product = parsed.fields['product'] || product;
            version = parsed.fields['version'] || version;
            if (parsed.files.length === 0) {
                throw new HttpError(400, 'no file part in multipart body');
            }
        } else {
            await writeFile(zipPath, body, { mode: 0o600 });
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
        await rm(workDir, { recursive: true }).catch(() => {});
    }
}

function requeueSymbolResult(
    result: SymbolIngestResult,
    db: Db,
): SymbolIngestAndRequeueResult {
    const requeued = db.requeueUnsymbolicated(
        result.product,
        result.version,
        Date.now(),
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
    requireValidNames(product, version);
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
    await mkdir(tmpDir(config.dataDir), { recursive: true });
    const workDir = await mkdtemp(join(tmpDir(config.dataDir), 'symbols-'));
    const zipPath = join(workDir, 'upload.zip');
    logEvent('symbols_upload_started', {
        product,
        version,
        source: 'artifact_crawler',
    });

    try {
        await writeFile(zipPath, body, { mode: 0o600 });
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
        await rm(workDir, { recursive: true }).catch(() => {});
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

export const _test = { runSymsorter };
