import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type FileEntry, Reader, ZipReader } from '@zip.js/zip.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Decompress } from 'fzstd';
import { x as extractTar } from 'tar';

import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { githubApiHeaders, githubHttpError } from './github.ts';
import { logEvent } from './log.ts';
import { tmpDir } from './paths.ts';
import {
    ingestSymbolDirectory,
    type SymbolIngestAndRequeueResult,
    type SymbolsOptions,
} from './symbols.ts';
import { FileHandleReader, fileWritable } from './zip.ts';

export type BuildArtifactKind = 'mac-build' | 'windows-build';

const MAX_DOWNLOAD_ATTEMPTS = 5;

class ArtifactSizeMismatchError extends Error {}

function zstdDecompressionStream(): TransformStream<Uint8Array, Uint8Array> {
    let decoder: Decompress;
    return new TransformStream({
        start(controller) {
            // fzstd reuses its output buffer after the callback returns.
            decoder = new Decompress((chunk) =>
                controller.enqueue(chunk.slice()),
            );
        },
        transform(chunk) {
            decoder.push(chunk);
        },
        flush() {
            decoder.push(new Uint8Array(), true);
        },
    });
}

interface RandomReader {
    readUint8Array(index: number, length: number): Promise<Uint8Array>;
}

class SliceReader extends Reader<null> {
    private parent: RandomReader;
    private baseOffset: number;
    private sliceSize: number;

    constructor(parent: RandomReader, baseOffset: number, sliceSize: number) {
        super(null);
        this.parent = parent;
        this.baseOffset = baseOffset;
        this.sliceSize = sliceSize;
    }

    override init(): Promise<void> {
        this.size = this.sliceSize;
        return Promise.resolve();
    }

    override readUint8Array(
        index: number,
        length: number,
    ): Promise<Uint8Array> {
        if (index < 0 || length < 0 || index + length > this.sliceSize) {
            throw new Error('nested ZIP read is outside the stored entry');
        }
        return this.parent.readUint8Array(this.baseOffset + index, length);
    }
}

async function countFiles(path: string): Promise<number> {
    const entries = await readdir(path, {
        recursive: true,
        withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile()).length;
}

async function extractMacBuildReader<T>(
    reader: Reader<T>,
    destDir: string,
): Promise<number> {
    const zip = new ZipReader(reader);
    try {
        let buildEntry: FileEntry | undefined;
        for await (const entry of zip.getEntriesGenerator()) {
            if (!entry.directory && entry.filename === 'build_src.tar.zst') {
                buildEntry = entry;
                break;
            }
        }
        if (!buildEntry) {
            throw new Error('macOS artifact has no build_src.tar.zst');
        }
        const extractor = extractTar({
            cwd: destDir,
            strict: true,
            preserveOwner: false,
            noMtime: true,
            chmod: false,
            filter: (path: string) =>
                /^src\/out\/Default\/[^/]+\.(?:app|dSYM)(?:\/|$)/.test(path),
        });
        const zstd = zstdDecompressionStream();
        await Promise.all([
            buildEntry.getData(zstd.writable),
            pipeline(Readable.fromWeb(zstd.readable), extractor),
        ]);

        const files = await countFiles(destDir);
        if (files === 0) {
            throw new Error('macOS build has no app/dSYM files');
        }

        return files;
    } finally {
        await zip.close().catch(() => {});
    }
}

async function storedEntryDataOffset(
    reader: RandomReader,
    offset: number,
): Promise<number> {
    const header = await reader.readUint8Array(offset, 30);
    const view = new DataView(
        header.buffer,
        header.byteOffset,
        header.byteLength,
    );
    if (view.getUint32(0, true) !== 0x04034b50) {
        throw new Error('invalid nested ZIP local header');
    }
    if (view.getUint16(8, true) !== 0) {
        throw new Error('nested artifacts.zip is not stored uncompressed');
    }
    return offset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
}

async function extractWindowsBuildReader<T>(
    reader: Reader<T>,
    destDir: string,
): Promise<number> {
    const outer = new ZipReader(reader);
    try {
        let nestedEntry: FileEntry | undefined;
        for await (const entry of outer.getEntriesGenerator()) {
            if (!entry.directory && entry.filename === 'artifacts.zip') {
                nestedEntry = entry;
                break;
            }
        }
        if (!nestedEntry || nestedEntry.compressionMethod !== 0) {
            throw new Error('Windows artifact has no stored artifacts.zip');
        }
        const dataOffset = await storedEntryDataOffset(
            reader,
            nestedEntry.offset,
        );
        const nested = new ZipReader(
            new SliceReader(reader, dataOffset, nestedEntry.compressedSize),
        );
        let files = 0;
        try {
            for await (const entry of nested.getEntriesGenerator()) {
                const path = entry.filename.replaceAll('\\', '/');
                if (
                    !/^src\/out\/Default\/[^/]+\.(?:exe|dll|pdb)$/i.test(path)
                ) {
                    continue;
                }
                if (entry.directory) {
                    continue;
                }

                await entry.getData(
                    await fileWritable(join(destDir, basename(path))),
                );
                files++;
            }
        } finally {
            await nested.close().catch(() => {});
        }
        return files;
    } finally {
        await outer.close().catch(() => {});
    }
}

async function extractBuild(
    artifactPath: string,
    destDir: string,
    kind: BuildArtifactKind,
): Promise<number> {
    await using file = await open(artifactPath, 'r');
    const reader = new FileHandleReader(file);
    return await (kind === 'mac-build'
        ? extractMacBuildReader(reader, destDir)
        : extractWindowsBuildReader(reader, destDir));
}

async function downloadArtifact(
    artifactUrl: string,
    artifactSize: number,
    token: string,
    artifactPath: string,
    fetchFn: typeof fetch = fetch,
    signal?: AbortSignal,
): Promise<void> {
    const file = await open(artifactPath, 'w', 0o600);
    let downloaded = 0;
    let lastLogged = 0;
    const started = Date.now();
    const logRetry = (attempt: number, err: unknown) =>
        logEvent('artifact_build_download_retry', {
            bytes: downloaded,
            total_bytes: artifactSize,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
        });

    try {
        for (
            let attempt = 1;
            attempt <= MAX_DOWNLOAD_ATTEMPTS && downloaded < artifactSize;
            attempt++
        ) {
            const headers = githubApiHeaders(token);
            if (downloaded > 0) headers.Range = `bytes=${downloaded}-`;

            let response: Response;
            try {
                response = await fetchFn(artifactUrl, {
                    headers,
                    redirect: 'follow',
                    signal,
                });
            } catch (err) {
                if (attempt >= MAX_DOWNLOAD_ATTEMPTS || signal?.aborted) {
                    throw err;
                }
                logRetry(attempt, err);
                continue;
            }
            if (!response.ok || !response.body) {
                throw await githubHttpError(
                    'GitHub artifact download failed',
                    response,
                );
            }
            if (downloaded > 0 && response.status !== 206) {
                await response.body.cancel();
                throw new ArtifactSizeMismatchError(
                    'artifact server did not honor download resume range',
                );
            }

            // artifactSize comes from GitHub's artifact metadata, not this
            // HTTP response. fetch does not know that expected size, so check
            // both the advertised length and the streamed bytes against it.
            const declared = Number(response.headers.get('content-length'));
            if (
                Number.isFinite(declared)
                && declared > artifactSize - downloaded
            ) {
                await response.body.cancel();
                throw new Error(
                    'artifact response exceeds its declared metadata size',
                );
            }

            try {
                for await (const chunk of response.body) {
                    if (chunk.length > artifactSize - downloaded) {
                        throw new ArtifactSizeMismatchError(
                            `artifact download exceeded expected size ${artifactSize}`,
                        );
                    }
                    let offset = 0;
                    while (offset < chunk.length) {
                        const { bytesWritten: written } = await file.write(
                            chunk.subarray(offset),
                        );
                        offset += written;
                        downloaded += written;
                    }
                    if (downloaded - lastLogged >= 512 * 1024 * 1024) {
                        lastLogged = downloaded;
                        logEvent('artifact_build_download_progress', {
                            bytes: downloaded,
                            total_bytes: artifactSize,
                            percent: Math.floor(
                                (downloaded * 100) / artifactSize,
                            ),
                            elapsed_ms: Date.now() - started,
                        });
                    }
                }
            } catch (err) {
                if (
                    err instanceof ArtifactSizeMismatchError
                    || attempt >= MAX_DOWNLOAD_ATTEMPTS
                    || signal?.aborted
                ) {
                    throw err;
                }

                logRetry(attempt, err);
                continue;
            }

            if (downloaded < artifactSize && attempt < MAX_DOWNLOAD_ATTEMPTS) {
                logRetry(
                    attempt,
                    'download ended before the expected artifact size',
                );
            }
        }
    } finally {
        await file.close();
    }

    if (downloaded !== artifactSize) {
        throw new Error(
            `artifact download ended at ${downloaded} of ${artifactSize} bytes`,
        );
    }
    logEvent('artifact_build_downloaded', {
        bytes: downloaded,
        elapsed_ms: Date.now() - started,
    });
}

/** Download a build artifact once, retain only runtime debug files, and ingest. */
export async function ingestBuildArtifact(
    artifactUrl: string,
    artifactSize: number,
    token: string,
    kind: BuildArtifactKind,
    product: string,
    version: string,
    config: Config,
    db: Db,
    fetchFn: typeof fetch = fetch,
    signal?: AbortSignal,
    opts: SymbolsOptions = {},
): Promise<SymbolIngestAndRequeueResult> {
    await mkdir(tmpDir(config.dataDir), { recursive: true });
    const workDir = await mkdtemp(
        join(tmpDir(config.dataDir), 'build-artifact-'),
    );
    const extractedDir = join(workDir, 'selected');
    const artifactPath = join(workDir, 'artifact.zip');
    await mkdir(extractedDir);

    try {
        await downloadArtifact(
            artifactUrl,
            artifactSize,
            token,
            artifactPath,
            fetchFn,
            signal,
        );
        let files: number;
        try {
            files = await extractBuild(artifactPath, extractedDir, kind);
        } catch (err) {
            throw new Error(
                `build artifact extraction failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                { cause: err },
            );
        }
        logEvent('artifact_build_selected', { kind, files, product, version });
        return await ingestSymbolDirectory(
            extractedDir,
            product,
            version,
            files,
            config,
            db,
            opts,
        );
    } finally {
        await rm(workDir, { recursive: true }).catch(() => {});
    }
}

export const _test = {
    downloadArtifact,
    extractBuild,
};
