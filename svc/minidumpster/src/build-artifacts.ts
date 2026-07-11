import { basename, join } from '@std/path';
import { configure, type FileEntry, Reader, ZipReader } from '@zip-js/zip-js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Decompress } from 'fzstd';
import { x as extractTar } from 'tar';

import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { githubHttpError } from './github.ts';
import { logEvent } from './log.ts';
import { tmpDir } from './paths.ts';
import {
    ingestSymbolDirectory,
    type SymbolIngestAndRequeueResult,
    type SymbolsOptions,
} from './symbols.ts';

configure({ useWebWorkers: false });

export type BuildArtifactKind = 'mac-build' | 'windows-build';

function zstdDecompressionStream(): TransformStream<Uint8Array, Uint8Array> {
    let decoder: Decompress;
    return new TransformStream({
        start(controller) {
            // fzstd reuses its output buffer after the callback returns.
            decoder = new Decompress((chunk) =>
                controller.enqueue(chunk.slice())
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

class DenoFileReader extends Reader<Deno.FsFile> {
    constructor(private file: Deno.FsFile) {
        super(file);
    }

    override async init(): Promise<void> {
        this.size = (await this.file.stat()).size;
    }

    override async readUint8Array(
        index: number,
        length: number,
    ): Promise<Uint8Array> {
        return await readFileRange(this.file, index, length);
    }
}

interface RandomReader {
    readUint8Array(index: number, length: number): Promise<Uint8Array>;
}

class SliceReader extends Reader<null> {
    constructor(
        private parent: RandomReader,
        private baseOffset: number,
        private sliceSize: number,
    ) {
        super(null);
    }

    override init(): Promise<void> {
        this.size = this.sliceSize;
        return Promise.resolve();
    }

    override async readUint8Array(
        index: number,
        length: number,
    ): Promise<Uint8Array> {
        if (index < 0 || length < 0 || index + length > this.sliceSize) {
            throw new Error('nested ZIP read is outside the stored entry');
        }
        return await this.parent.readUint8Array(
            this.baseOffset + index,
            length,
        );
    }
}

async function readFileRange(
    file: Deno.FsFile,
    index: number,
    length: number,
): Promise<Uint8Array> {
    await file.seek(index, Deno.SeekMode.Start);
    const buf = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
        const read = await file.read(buf.subarray(offset));
        if (read === null) {
            break;
        }

        offset += read;
    }
    if (offset !== length) {
        throw new Error('unexpected end of artifact');
    }

    return buf;
}

async function countFiles(path: string): Promise<number> {
    let count = 0;
    for await (const entry of Deno.readDir(path)) {
        if (entry.isFile) {
            count++;
        } else if (entry.isDirectory) {
            count += await countFiles(join(path, entry.name));
        }
    }
    return count;
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
            pipeline(
                Readable.fromWeb(
                    zstd.readable as unknown as NodeReadableStream,
                ),
                extractor,
            ),
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
        let nestedEntry:
            | Awaited<ReturnType<typeof outer.getEntries>>[number]
            | undefined;
        for await (const entry of outer.getEntriesGenerator()) {
            if (entry.filename === 'artifacts.zip') {
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

                const output = await Deno.open(join(destDir, basename(path)), {
                    create: true,
                    truncate: true,
                    write: true,
                });
                try {
                    await entry.getData(output.writable);
                } catch (err) {
                    try {
                        output.close();
                    } catch {
                        // getData closes the stream
                    }
                    throw err;
                }
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

async function extractMacBuild(
    artifactPath: string,
    destDir: string,
): Promise<number> {
    const file = await Deno.open(artifactPath, { read: true });
    try {
        return await extractMacBuildReader(new DenoFileReader(file), destDir);
    } finally {
        file.close();
    }
}

async function extractWindowsBuild(
    artifactPath: string,
    destDir: string,
): Promise<number> {
    const file = await Deno.open(artifactPath, { read: true });
    try {
        return await extractWindowsBuildReader(
            new DenoFileReader(file),
            destDir,
        );
    } finally {
        file.close();
    }
}

async function downloadArtifact(
    artifactUrl: string,
    artifactSize: number,
    token: string,
    artifactPath: string,
    fetchFn: typeof fetch = fetch,
    signal?: AbortSignal,
): Promise<void> {
    const file = await Deno.open(artifactPath, {
        create: true,
        truncate: true,
        write: true,
    });
    let downloaded = 0;
    let lastLogged = 0;
    const started = Date.now();

    try {
        for (
            let attempt = 1;
            attempt <= 5 && downloaded < artifactSize;
            attempt++
        ) {
            const headers: Record<string, string> = {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'minidumpster-artifact-crawler',
            };
            if (downloaded > 0) headers.Range = `bytes=${downloaded}-`;

            const response = await fetchFn(artifactUrl, {
                headers,
                redirect: 'follow',
                signal,
            });
            if (!response.ok || !response.body) {
                throw await githubHttpError(
                    'GitHub artifact download failed',
                    response,
                );
            }
            if (downloaded > 0 && response.status !== 206) {
                await response.body.cancel();
                throw new Error(
                    'artifact server did not honor download resume range',
                );
            }

            try {
                for await (const chunk of response.body) {
                    let offset = 0;
                    while (offset < chunk.length) {
                        offset += await file.write(chunk.subarray(offset));
                    }
                    downloaded += chunk.length;
                    if (downloaded > artifactSize) {
                        throw new Error(
                            `artifact download exceeded expected size ${artifactSize}`,
                        );
                    }
                    if (downloaded - lastLogged >= 512 * 1024 * 1024) {
                        lastLogged = downloaded;
                        logEvent('artifact_build_download_progress', {
                            bytes: downloaded,
                            total_bytes: artifactSize,
                            percent: Math.floor(
                                downloaded * 100 / artifactSize,
                            ),
                            elapsed_ms: Date.now() - started,
                        });
                    }
                }
            } catch (err) {
                if (attempt >= 5 || signal?.aborted) {
                    throw err;
                }

                logEvent('artifact_build_download_retry', {
                    bytes: downloaded,
                    total_bytes: artifactSize,
                    attempt: attempt + 1,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            if (downloaded < artifactSize && attempt < 5) {
                logEvent('artifact_build_download_retry', {
                    bytes: downloaded,
                    total_bytes: artifactSize,
                    attempt: attempt + 1,
                    error: 'download ended before the expected artifact size',
                });
            }
        }
    } finally {
        file.close();
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
    await Deno.mkdir(tmpDir(config.dataDir), { recursive: true });
    const workDir = await Deno.makeTempDir({
        dir: tmpDir(config.dataDir),
        prefix: 'build-artifact-',
    });
    const extractedDir = join(workDir, 'selected');
    const artifactPath = join(workDir, 'artifact.zip');
    await Deno.mkdir(extractedDir);

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
            files = kind === 'mac-build'
                ? await extractMacBuild(artifactPath, extractedDir)
                : await extractWindowsBuild(artifactPath, extractedDir);
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
        await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
}

export const _test = {
    downloadArtifact,
    extractMacBuild,
    extractWindowsBuild,
};
