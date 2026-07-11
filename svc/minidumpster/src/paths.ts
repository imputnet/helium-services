import { dirname, join } from '@std/path';

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
    for (
        const d of [
            join(dataDir, 'dumps'),
            join(dataDir, 'processed'),
            symbolsDir(dataDir),
            tmpDir(dataDir),
        ]
    ) {
        await Deno.mkdir(d, { recursive: true });
    }
}

export async function writeFileWithDirs(
    path: string,
    data: Uint8Array | string,
): Promise<void> {
    await Deno.mkdir(dirname(path), { recursive: true });
    if (typeof data === 'string') {
        await Deno.writeTextFile(path, data);
    } else {
        await Deno.writeFile(path, data);
    }
}
