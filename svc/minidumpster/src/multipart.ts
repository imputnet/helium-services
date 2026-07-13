// @ts-types="@types/busboy"
import busboy from 'busboy';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export interface StreamedFile {
    field: string;
    filename: string;
    path: string;
    size: number;
}

export interface StreamedMultipart {
    fields: Record<string, string>;
    files: StreamedFile[];
}

export function streamMultipartToDisk(
    body: ReadableStream<Uint8Array>,
    contentType: string,
    fileDest: (field: string, filename: string) => string,
    opts: { maxFieldBytes?: number } = {},
): Promise<StreamedMultipart> {
    return new Promise((resolve, reject) => {
        let bb: busboy.Busboy;
        try {
            bb = busboy({
                headers: { 'content-type': contentType },
                limits: { fieldSize: opts.maxFieldBytes ?? 64 * 1024 },
            });
        } catch (err) {
            reject(err);
            return;
        }

        const fields: Record<string, string> = {};
        const files: StreamedFile[] = [];
        const fileWrites: Promise<void>[] = [];
        let failed = false;
        const fail = (err: unknown) => {
            if (failed) {
                return;
            }

            failed = true;
            reject(err instanceof Error ? err : new Error(String(err)));
        };

        let filesStarted = 0;

        bb.on('field', (name, value) => {
            fields[name] = value;
        });

        bb.on('file', (name, stream, info) => {
            filesStarted++;
            if (filesStarted > 1) {
                // Drain so busboy can complete parsing, then fail.
                stream.resume();
                fail(new Error('multipart: too many files'));
                return;
            }

            // Late 'error' events (e.g. truncated form) would otherwise be uncaught
            // once pipeline has detached its listeners.
            stream.on('error', fail);
            const path = fileDest(name, info.filename ?? '');
            fileWrites.push(
                pipeline(stream, createWriteStream(path))
                    .then(async () => {
                        const { size } = await Deno.stat(path);
                        files.push({
                            field: name,
                            filename: info.filename ?? '',
                            path,
                            size,
                        });
                    })
                    .catch(fail),
            );
        });

        bb.on('error', fail);
        bb.on('partsLimit', () => fail(new Error('multipart: too many parts')));
        bb.on('close', () => {
            Promise.all(fileWrites)
                .then(() => {
                    if (!failed) {
                        resolve({ fields, files });
                    }
                })
                .catch(fail);
        });

        Readable.from(body).on('error', fail).pipe(bb);
    });
}
