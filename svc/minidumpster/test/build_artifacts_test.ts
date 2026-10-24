import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { _test } from '../src/build-artifacts.ts';
import { makeTempDir, makeZip } from './helpers.ts';

function writeString(
    target: Uint8Array,
    offset: number,
    length: number,
    value: string,
): void {
    target.set(new TextEncoder().encode(value).slice(0, length), offset);
}

function writeOctal(
    target: Uint8Array,
    offset: number,
    length: number,
    value: number,
): void {
    writeString(
        target,
        offset,
        length,
        value.toString(8).padStart(length - 1, '0') + '\0',
    );
}

function tarEntry(name: string, data: Uint8Array): Uint8Array {
    const header = new Uint8Array(512);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o600);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');

    const padded = Math.ceil(data.byteLength / 512) * 512;
    const result = new Uint8Array(512 + padded);
    result.set(header);
    result.set(data, 512);
    return result;
}

function makeTar(entries: Uint8Array[]): Uint8Array {
    const length = entries.reduce((sum, entry) => sum + entry.length, 0);
    const tar = new Uint8Array(length + 1024);
    let offset = 0;
    for (const entry of entries) {
        tar.set(entry, offset);
        offset += entry.length;
    }
    return tar;
}

/** A standards-compliant Zstandard frame containing only raw blocks. */
function rawZstd(data: Uint8Array): Uint8Array {
    const maxBlock = 128 * 1024;
    const blocks = Math.ceil(data.byteLength / maxBlock);
    const frame = new Uint8Array(6 + data.byteLength + blocks * 3);
    frame.set([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38]);
    let input = 0;
    let output = 6;
    while (input < data.byteLength) {
        const size = Math.min(maxBlock, data.byteLength - input);
        const last = input + size === data.byteLength;
        const header = size * 8 + (last ? 1 : 0);
        frame[output++] = header & 0xff;
        frame[output++] = (header >>> 8) & 0xff;
        frame[output++] = (header >>> 16) & 0xff;
        frame.set(data.subarray(input, input + size), output);
        output += size;
        input += size;
    }
    return frame;
}

test('artifact downloads do not retry streamed size violations', async () => {
    const dir = await makeTempDir();
    try {
        let requests = 0;
        const fetchMock: typeof fetch = () => {
            requests++;
            return Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new Uint8Array([1, 2, 3]));
                            controller.close();
                        },
                    }),
                ),
            );
        };

        await assert.rejects(
            () =>
                _test.downloadArtifact(
                    'https://example.test/artifact.zip',
                    2,
                    'token',
                    join(dir, 'artifact.zip'),
                    fetchMock,
                ),
            { message: /exceeded expected size/ },
        );
        assert.equal(requests, 1);
    } finally {
        await rm(dir, { recursive: true });
    }
});

test('artifact downloads reject a size header that exceeds metadata', async () => {
    const dir = await makeTempDir();
    try {
        let requests = 0;
        const fetchMock: typeof fetch = () => {
            requests++;
            return Promise.resolve(
                new Response(new Uint8Array([1, 2, 3]), {
                    headers: { 'content-length': '3' },
                }),
            );
        };

        await assert.rejects(
            () =>
                _test.downloadArtifact(
                    'https://example.test/artifact.zip',
                    2,
                    'token',
                    join(dir, 'artifact.zip'),
                    fetchMock,
                ),
            { message: /exceeds its declared metadata size/ },
        );
        assert.equal(requests, 1);
    } finally {
        await rm(dir, { recursive: true });
    }
});

test('artifact downloads retry transient connection failures', async () => {
    const dir = await makeTempDir();
    try {
        let requests = 0;
        const fetchMock: typeof fetch = () => {
            requests++;
            if (requests === 1) {
                return Promise.reject(new TypeError('connection reset'));
            }
            return Promise.resolve(
                new Response(new Uint8Array([1, 2]), {
                    headers: { 'content-length': '2' },
                }),
            );
        };
        const artifact = join(dir, 'artifact.zip');
        await _test.downloadArtifact(
            'https://example.test/artifact.zip',
            2,
            'token',
            artifact,
            fetchMock,
        );
        assert.equal(requests, 2);
        assert.deepStrictEqual(
            new Uint8Array(await readFile(artifact)),
            new Uint8Array([1, 2]),
        );
    } finally {
        await rm(dir, { recursive: true });
    }
});

test('Windows nested artifacts extract selected files', async () => {
    const dir = await makeTempDir();
    try {
        const nested = await makeZip(
            [
                [
                    'src/out/Default/helium.pdb',
                    new TextEncoder().encode('pdb!'),
                ],
                ['src/out/Default/ignored.txt', new Uint8Array([1])],
            ],
            0,
        );
        const outer = await makeZip([['artifacts.zip', nested]], 0);
        const artifact = join(dir, 'windows.zip');
        await writeFile(artifact, outer);

        const out = join(dir, 'selected');
        await mkdir(out);
        assert.deepStrictEqual(
            await _test.extractBuild(artifact, out, 'windows-build'),
            1,
        );
        assert.equal(await readFile(join(out, 'helium.pdb'), 'utf8'), 'pdb!');
    } finally {
        await rm(dir, { recursive: true });
    }
});

test('macOS zstd/tar extraction selects build files', async () => {
    const dir = await makeTempDir();
    try {
        const filePath = 'src/out/Default/Helium.app/Contents/MacOS/Helium';
        const tar = makeTar([
            tarEntry(filePath, new TextEncoder().encode('app!')),
        ]);
        const artifact = join(dir, 'mac.zip');
        await writeFile(
            artifact,
            await makeZip([['build_src.tar.zst', rawZstd(tar)]], 0),
        );

        const out = join(dir, 'mac-selected');
        await mkdir(out);
        assert.deepStrictEqual(
            await _test.extractBuild(artifact, out, 'mac-build'),
            1,
        );
        assert.deepStrictEqual(
            await readFile(join(out, filePath), 'utf8'),
            'app!',
        );
    } finally {
        await rm(dir, { recursive: true });
    }
});
