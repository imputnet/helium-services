import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { extractZip } from '../src/zip.ts';
import { makeTempDir, makeZip } from './helpers.ts';

test('extractZip preserves nested paths (dSYM-style bundles)', async () => {
    const dir = await makeTempDir();
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
        await writeFile(zipPath, zipBytes);

        const out = join(dir, 'out');
        await mkdir(out);
        const count = await extractZip(zipPath, out);
        assert.equal(count, 3);
        assert.deepStrictEqual(
            new Uint8Array(
                await readFile(
                    join(
                        out,
                        'MyBrowser.app.dSYM/Contents/Resources/DWARF/MyBrowser',
                    ),
                ),
            ),
            dwarf,
        );
        assert.deepStrictEqual(
            await readFile(join(out, 'mybrowser.pdb'), 'utf8'),
            'fake pdb',
        );
    } finally {
        await rm(dir, { recursive: true });
    }
});

test('extractZip rejects zip-slip entry paths', async () => {
    const dir = await makeTempDir();
    try {
        const zipPath = join(dir, 'evil.zip');
        await writeFile(zipPath, await makeZip([['../evil.txt', 'pwned']]));
        const out = join(dir, 'out');
        await mkdir(out);
        let threw = false;
        try {
            await extractZip(zipPath, out);
        } catch (e) {
            threw = true;
            assert(String(e).includes('unsafe zip entry path'));
        }
        assert(threw, 'path traversal entry should be rejected');
    } finally {
        await rm(dir, { recursive: true });
    }
});

test('extractZip rejects non-zip data', async () => {
    const dir = await makeTempDir();
    try {
        const zipPath = join(dir, 'not.zip');
        await writeFile(zipPath, new Uint8Array(1000).fill(7));
        let threw = false;
        try {
            await extractZip(zipPath, join(dir, 'out'));
        } catch {
            threw = true;
        }
        assert(threw, 'garbage input should throw');
    } finally {
        await rm(dir, { recursive: true });
    }
});
