import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm } from 'node:fs/promises';

import { chunked, encodeMultipart, makeTempDir } from './helpers.ts';
import { streamMultipartToDisk } from '../src/multipart.ts';

test('streaming multipart parser writes files to disk and collects fields', async () => {
    const dir = await makeTempDir();
    try {
        const payload = new Uint8Array(10_000);
        for (let i = 0; i < payload.length; i++) {
            payload[i] = i % 251;
        }
        const form = new FormData();
        form.append('product', 'mybrowser');
        form.append('version', '138.0.1.0');
        form.append('file', new Blob([payload.slice()]), 'symbols.zip');
        const { bytes, contentType } = await encodeMultipart(form);

        for (const chunkSize of [7, 1024, bytes.length]) {
            const dest = join(dir, `out-${chunkSize}.bin`);
            const result = await streamMultipartToDisk(
                chunked(bytes, chunkSize),
                contentType,
                () => dest,
            );
            assert.equal(result.fields['product'], 'mybrowser');
            assert.equal(result.fields['version'], '138.0.1.0');
            assert.equal(result.files.length, 1);
            assert.equal(result.files[0].field, 'file');
            assert.equal(result.files[0].filename, 'symbols.zip');
            assert.deepStrictEqual(result.files[0].size, payload.length);
            assert.deepStrictEqual(
                new Uint8Array(await readFile(dest)),
                payload,
            );
        }
    } finally {
        await rm(dir, { recursive: true });
    }
});

test('streaming multipart parser rejects truncated bodies', async () => {
    const dir = await makeTempDir();
    try {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(100)]), 'x.zip');
        const { bytes, contentType } = await encodeMultipart(form);
        await assert.rejects(() =>
            streamMultipartToDisk(
                chunked(bytes.slice(0, bytes.length - 20), 16),
                contentType,
                () => join(dir, 'trunc.bin'),
            ),
        );
    } finally {
        await rm(dir, { recursive: true });
    }
});

test('streaming multipart parser rejects a missing boundary', async () => {
    await assert.rejects(() =>
        streamMultipartToDisk(
            chunked(new Uint8Array(10), 10),
            'multipart/form-data',
            () => '/dev/null',
        ),
    );
});

test('streaming multipart parser does not cap the complete body', async () => {
    const dir = await makeTempDir();
    try {
        const form = new FormData();
        form.append(
            'file',
            new Blob([new Uint8Array(16 * 1024 * 1024)]),
            'large.bin',
        );
        const { bytes, contentType } = await encodeMultipart(form);
        const result = await streamMultipartToDisk(
            chunked(bytes, 64 * 1024),
            contentType,
            () => join(dir, 'large.bin'),
        );
        assert.deepStrictEqual(result.files[0].size, 16 * 1024 * 1024);
    } finally {
        await rm(dir, { recursive: true });
    }
});
