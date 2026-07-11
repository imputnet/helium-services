import { join } from '@std/path';
import { assert, assertEquals } from '@std/assert';
import {
    BlobWriter,
    TextReader,
    Uint8ArrayReader,
    ZipWriter,
} from '@zip-js/zip-js';

import { extractZip } from '../src/zip.ts';

async function makeZip(
    entries: [string, Uint8Array | string][],
): Promise<Uint8Array> {
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    for (const [name, data] of entries) {
        await writer.add(
            name,
            typeof data === 'string'
                ? new TextReader(data)
                : new Uint8ArrayReader(data),
        );
    }
    return new Uint8Array(await (await writer.close()).arrayBuffer());
}

Deno.test('extractZip preserves nested paths (dSYM-style bundles)', async () => {
    const dir = await Deno.makeTempDir();
    try {
        const dwarf = new Uint8Array(5000);
        for (let i = 0; i < dwarf.length; i++) {
            dwarf[i] = i % 253;
        }
        const zipBytes = await makeZip([
            ['MyBrowser.app.dSYM/Contents/Info.plist', '<plist/>'],
            ['MyBrowser.app.dSYM/Contents/Resources/DWARF/MyBrowser', dwarf],
            ['mybrowser.pdb', 'fake pdb'],
        ]);
        const zipPath = join(dir, 'in.zip');
        await Deno.writeFile(zipPath, zipBytes);

        const out = join(dir, 'out');
        await Deno.mkdir(out);
        const count = await extractZip(zipPath, out);
        assertEquals(count, 3);
        assertEquals(
            await Deno.readFile(
                join(
                    out,
                    'MyBrowser.app.dSYM/Contents/Resources/DWARF/MyBrowser',
                ),
            ),
            dwarf,
        );
        assertEquals(
            await Deno.readTextFile(join(out, 'mybrowser.pdb')),
            'fake pdb',
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test('extractZip rejects zip-slip entry paths', async () => {
    const dir = await Deno.makeTempDir();
    try {
        const zipPath = join(dir, 'evil.zip');
        await Deno.writeFile(
            zipPath,
            await makeZip([['../evil.txt', 'pwned']]),
        );
        const out = join(dir, 'out');
        await Deno.mkdir(out);
        let threw = false;
        try {
            await extractZip(zipPath, out);
        } catch (e) {
            threw = true;
            assert(String(e).includes('unsafe zip entry path'));
        }
        assert(threw, 'path traversal entry should be rejected');
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test('extractZip rejects non-zip data', async () => {
    const dir = await Deno.makeTempDir();
    try {
        const zipPath = join(dir, 'not.zip');
        await Deno.writeFile(zipPath, new Uint8Array(1000).fill(7));
        let threw = false;
        try {
            await extractZip(zipPath, join(dir, 'out'));
        } catch {
            threw = true;
        }
        assert(threw, 'garbage input should throw');
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});
