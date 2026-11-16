import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const MAX_NAME_LENGTH = 512;

/** Same as Chromium's base::HashMetricName: the first 8 bytes of MD5(name),
 * read as a big-endian unsigned integer. */
export function hashMetricName(name: string): bigint {
    return createHash('md5').update(name).digest().readBigUInt64BE(0);
}

/** Hashes are unsigned 64-bit, but SQLite integers are signed. */
export function hashToDb(hash: bigint): bigint {
    return BigInt.asIntN(64, hash);
}

export function hashFromDb(value: bigint | number): bigint {
    return BigInt.asUintN(64, BigInt(value));
}

export function hashToHex(hash: bigint): string {
    return hash.toString(16).padStart(16, '0');
}

export function hashFromHex(hex: string): bigint | null {
    return /^[0-9a-f]{16}$/i.test(hex) ? BigInt(`0x${hex}`) : null;
}

export function parseNameList(text: string): string[] {
    const names = new Set<string>();

    for (const line of text.split('\n')) {
        const name = line.trim();

        if (
            name === ''
            || name.startsWith('#')
            || name.length > MAX_NAME_LENGTH
            || /[\s\p{Cc}]/u.test(name)
        ) {
            continue;
        }

        names.add(name);
    }

    return [...names];
}

export function hashNames(
    names: string[],
): { hash: bigint; name: string }[] {
    return names.map((name) => ({ hash: hashMetricName(name), name }));
}

export async function loadAllowlist(path: string): Promise<Set<bigint>> {
    const names = parseNameList(await readFile(path, 'utf8'));

    return new Set(hashNames(names).map((n) => n.hash));
}
