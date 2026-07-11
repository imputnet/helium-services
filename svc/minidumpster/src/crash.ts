export class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

export interface ParsedCrash {
    dump: Uint8Array;
    annotations: Record<string, string>;
}

async function readAllCapped(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.byteLength;
        if (total > maxBytes) {
            await stream.cancel().catch(() => {});
            throw new HttpError(413, `body exceeds limit of ${maxBytes} bytes`);
        }
        chunks.push(chunk);
    }

    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }

    return out;
}

export async function parseCrashRequest(
    req: Request,
    maxBytes: number,
): Promise<ParsedCrash> {
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
        throw new HttpError(415, 'expected multipart/form-data');
    }
    if (!req.body) {
        throw new HttpError(400, 'empty request body');
    }

    let body: ReadableStream<Uint8Array> = req.body;
    const encoding = (req.headers.get('content-encoding') ?? '').toLowerCase();
    if (encoding.includes('gzip')) {
        try {
            // Deno types DecompressionStream's writable side as BufferSource, which
            // WritableStream's invariance makes incompatible with Uint8Array.
            body = body.pipeThrough(
                new DecompressionStream('gzip') as unknown as TransformStream<
                    Uint8Array,
                    Uint8Array
                >,
            );
        } catch {
            throw new HttpError(400, 'invalid gzip body');
        }
    } else if (encoding !== '' && encoding !== 'identity') {
        throw new HttpError(415, `unsupported content-encoding: ${encoding}`);
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = await readAllCapped(body, maxBytes);
    } catch (e) {
        if (e instanceof HttpError) {
            throw e;
        }
        throw new HttpError(400, 'invalid request body (bad gzip?)');
    }

    // Reuse the platform multipart parser by wrapping the decoded bytes.
    const inner = new Request('http://multipart.local/', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: bytes,
    });
    let form: FormData;
    try {
        form = await inner.formData();
    } catch {
        throw new HttpError(400, 'malformed multipart body');
    }

    const dumpEntry = form.get('upload_file_minidump');
    if (!(dumpEntry instanceof File)) {
        throw new HttpError(400, 'missing upload_file_minidump part');
    }
    const dump = new Uint8Array(await dumpEntry.arrayBuffer());
    if (dump.byteLength === 0) {
        throw new HttpError(400, 'empty minidump');
    }

    const annotations: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
        if (typeof value === 'string') {
            annotations[key] = value;
        }
    }

    return { dump, annotations };
}
