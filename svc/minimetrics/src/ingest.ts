import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { dayOf, type Db, type RecordResult } from './db.ts';
import { ProtoError } from './proto.ts';
import { parseUmaLog } from './uma.ts';

export class HttpError extends Error {
    readonly status: ContentfulStatusCode;

    constructor(status: ContentfulStatusCode, message: string) {
        super(message);
        this.status = status;
    }
}

async function readAllCapped(
    stream: AsyncIterable<Uint8Array>,
    maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of stream) {
        total += chunk.byteLength;

        if (total > maxBytes) {
            // Throwing out of the loop closes the stream. Chromium retries
            // anything but 200 and 400, so oversized logs get a 400 to make
            // the client drop them instead of retrying.
            throw new HttpError(400, `body exceeds limit of ${maxBytes} bytes`);
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

/** The size cap applies to the decompressed bytes, so gzip bombs are cut
 * off early. */
export async function readBody(
    req: Request,
    maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
    if (!req.body) {
        throw new HttpError(400, 'empty request body');
    }

    let body: AsyncIterable<Uint8Array> = req.body;
    const encoding = (req.headers.get('content-encoding') ?? '').toLowerCase();

    if (encoding === 'gzip') {
        body = Readable.from(req.body).pipe(createGunzip());
    } else if (encoding !== '' && encoding !== 'identity') {
        throw new HttpError(400, `unsupported content-encoding: ${encoding}`);
    }

    try {
        return await readAllCapped(body, maxBytes);
    } catch (err) {
        if (err instanceof HttpError) {
            throw err;
        }

        throw new HttpError(400, 'invalid request body (bad gzip?)');
    }
}

function sha1Hex(data: Uint8Array): string {
    return createHash('sha1').update(data).digest('hex');
}

export function clientHash(salt: Uint8Array, clientId: bigint): Uint8Array {
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(clientId);

    // 16 bytes is plenty to keep a day's clients apart.
    return createHmac('sha256', salt).update(id).digest().subarray(0, 16);
}

export interface IngestOptions {
    allow?: (hash: bigint) => boolean;
    now?: number;
}

export interface IngestResult {
    result: RecordResult;
    histograms: number;
    bytes: number;
}

export async function ingestLog(
    req: Request,
    db: Db,
    maxBytes: number,
    opts: IngestOptions = {},
): Promise<IngestResult> {
    const body = await readBody(req, maxBytes);

    if (body.byteLength === 0) {
        throw new HttpError(400, 'empty log');
    }

    // Chromium sends the hex SHA-1 of the uncompressed log. It doubles as an
    // integrity check and as the key for dropping retried uploads.
    const sha1 = sha1Hex(body);
    const claimed = req.headers.get('x-chrome-uma-log-sha1');

    if (claimed && claimed.toLowerCase() !== sha1) {
        throw new HttpError(400, 'log does not match X-Chrome-UMA-Log-SHA1');
    }

    let log;

    try {
        log = parseUmaLog(body);
    } catch (err) {
        if (err instanceof ProtoError) {
            throw new HttpError(400, `malformed log: ${err.message}`);
        }

        throw err;
    }

    const now = opts.now ?? Date.now();

    const hash = log.clientId === 0n
        ? null
        : clientHash(db.saltFor(dayOf(now)), log.clientId);

    const result = db.recordLog(sha1, log, now, {
        clientHash: hash,
        allow: opts.allow,
    });

    return {
        result,
        histograms: log.histograms.length,
        bytes: body.byteLength,
    };
}
