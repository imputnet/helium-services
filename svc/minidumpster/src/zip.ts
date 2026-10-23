import { type FileHandle, mkdir, open } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { configure, Reader, ZipReader } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

export class FileHandleReader extends Reader<FileHandle> {
    private file: FileHandle;

    constructor(file: FileHandle) {
        super(file);
        this.file = file;
    }

    override async init(): Promise<void> {
        this.size = (await this.file.stat()).size;
    }

    override async readUint8Array(
        index: number,
        length: number,
    ): Promise<Uint8Array> {
        const buf = new Uint8Array(length);
        let off = 0;
        while (off < length) {
            const { bytesRead } = await this.file.read(
                buf,
                off,
                length - off,
                index + off,
            );
            if (bytesRead === 0) {
                break;
            }
            off += bytesRead;
        }
        return buf.subarray(0, off);
    }
}

// not Writable.toWeb(), which queues 64k chunks instead of waiting for disk
export async function fileWritable(
    path: string,
): Promise<WritableStream<Uint8Array>> {
    const file = await open(path, 'w');
    return new WritableStream({
        async write(chunk) {
            try {
                await file.writeFile(chunk);
            } catch (err) {
                await file.close();
                throw err;
            }
        },
        close: () => file.close(),
        abort: () => file.close(),
    });
}

export async function extractZip(
    zipPath: string,
    destDir: string,
): Promise<number> {
    await using file = await open(zipPath, 'r');
    const zipReader = new ZipReader(new FileHandleReader(file));
    let count = 0;
    try {
        for await (const entry of zipReader.getEntriesGenerator()) {
            const rel = normalize(entry.filename.replaceAll('\\', '/'));
            if (
                rel.startsWith('/')
                || rel === '..'
                || rel.startsWith('../')
                || rel.includes('/../')
            ) {
                throw new Error(`unsafe zip entry path: ${entry.filename}`);
            }

            const dest = join(destDir, rel);
            if (entry.directory) {
                await mkdir(dest, { recursive: true });
                continue;
            }
            await mkdir(dirname(dest), { recursive: true });
            await entry.getData!(await fileWritable(dest));
            count++;
        }
    } finally {
        await zipReader.close().catch(() => {});
    }
    return count;
}
