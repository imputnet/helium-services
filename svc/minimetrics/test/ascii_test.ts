import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

// Sources stay plain ASCII; pages use HTML entities where a symbol is needed.
async function* files(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            yield* files(path);
        } else {
            yield path;
        }
    }
}

test('source files are ASCII', async () => {
    const root = new URL('..', import.meta.url).pathname;

    const paths = [
        ...await Array.fromAsync(files(join(root, 'src'))),
        ...await Array.fromAsync(files(join(root, 'test'))),
        ...[
            'README.md',
            'package.json',
            'dprint.json',
            '.env.example',
            'compose.yml',
            'Dockerfile',
        ].map((f) => join(root, f)),
    ];

    for (const path of paths) {
        const lines = (await readFile(path, 'utf8')).split('\n');
        lines.forEach((line, i) => {
            assert.ok(
                !/[^\t\r\x20-\x7e]/.test(line),
                `non-ASCII or control character in ${path}:${
                    i + 1
                }: ${line.trim()}`,
            );
        });
    }
});
