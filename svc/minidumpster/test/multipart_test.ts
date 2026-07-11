import { join } from '@std/path';
import { assert, assertEquals } from '@std/assert';

import { encodeMultipart } from './helpers.ts';
import { streamMultipartToDisk } from '../src/multipart.ts';

/** Re-stream bytes in tiny chunks so boundaries span chunk borders. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
    let off = 0;
    return new ReadableStream({
        pull(controller) {
            if (off >= bytes.length) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(off, off + size));
            off += size;
        },
    });
}

Deno.test('streaming multipart parser writes files to disk and collects fields', async () => {
    const dir = await Deno.makeTempDir();
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
            assertEquals(result.fields['product'], 'mybrowser');
            assertEquals(result.fields['version'], '138.0.1.0');
            assertEquals(result.files.length, 1);
            assertEquals(result.files[0].field, 'file');
            assertEquals(result.files[0].filename, 'symbols.zip');
            assertEquals(result.files[0].size, payload.length);
            assertEquals(await Deno.readFile(dest), payload);
        }
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test('streaming multipart parser rejects truncated bodies', async () => {
    const dir = await Deno.makeTempDir();
    try {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(100)]), 'x.zip');
        const { bytes, contentType } = await encodeMultipart(form);
        let threw = false;
        try {
            await streamMultipartToDisk(
                chunked(bytes.slice(0, bytes.length - 20), 16),
                contentType,
                () => join(dir, 'trunc.bin'),
            );
        } catch {
            threw = true;
        }
        assert(threw, 'truncated multipart should throw');
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test('streaming multipart parser rejects a missing boundary', async () => {
    let threw = false;
    try {
        await streamMultipartToDisk(
            chunked(new Uint8Array(10), 10),
            'multipart/form-data',
            () => '/dev/null',
        );
    } catch {
        threw = true;
    }
    assert(threw, 'content-type without boundary should throw');
});
