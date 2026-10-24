import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function dumpPath(dataDir: string, id: string): string {
    return join(dataDir, 'dumps', id.slice(0, 2), `${id}.dmp`);
}

export function processedPath(dataDir: string, id: string): string {
    return join(dataDir, 'processed', id.slice(0, 2), `${id}.json`);
}

export function symbolsDir(dataDir: string): string {
    return join(dataDir, 'symbols');
}

export function tmpDir(dataDir: string): string {
    return join(dataDir, 'tmp');
}

export function dbPath(dataDir: string): string {
    return join(dataDir, 'db.sqlite');
}

export async function ensureDataDirs(dataDir: string): Promise<void> {
    for (const d of [
        join(dataDir, 'dumps'),
        join(dataDir, 'processed'),
        symbolsDir(dataDir),
        tmpDir(dataDir),
    ]) {
        await mkdir(d, { recursive: true });
    }
}

export async function writeFileWithDirs(
    path: string,
    data: Uint8Array | string,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
}

export function isNotFound(err: unknown): boolean {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
