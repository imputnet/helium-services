import { dirname, join, normalize } from '@std/path';
import { configure, Reader, ZipReader } from '@zip-js/zip-js';

configure({ useWebWorkers: false });

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
        await this.file.seek(index, Deno.SeekMode.Start);
        const buf = new Uint8Array(length);
        let off = 0;
        while (off < length) {
            const n = await this.file.read(buf.subarray(off));
            if (n === null) {
                break;
            }
            off += n;
        }
        return buf.subarray(0, off);
    }
}

export async function extractZip(
    zipPath: string,
    destDir: string,
): Promise<number> {
    const file = await Deno.open(zipPath, { read: true });
    const zipReader = new ZipReader(new DenoFileReader(file));
    let count = 0;
    try {
        for await (const entry of zipReader.getEntriesGenerator()) {
            const rel = normalize(entry.filename.replaceAll('\\', '/'));
            if (
                rel.startsWith('/') || rel === '..' || rel.startsWith('../')
                || rel.includes('/../')
            ) {
                throw new Error(`unsafe zip entry path: ${entry.filename}`);
            }

            const dest = join(destDir, rel);
            if (entry.directory) {
                await Deno.mkdir(dest, { recursive: true });
                continue;
            }
            await Deno.mkdir(dirname(dest), { recursive: true });
            const out = await Deno.open(dest, {
                write: true,
                create: true,
                truncate: true,
            });
            try {
                // getData closes the writable stream (and thereby the file) itself.
                await entry.getData!(out.writable);
            } catch (err) {
                try {
                    out.close();
                } catch {
                    // already closed by the failed stream
                }
                throw err;
            }
            count++;
        }
    } finally {
        await zipReader.close().catch(() => {});
        try {
            file.close();
        } catch {
            // already closed
        }
    }
    return count;
}
