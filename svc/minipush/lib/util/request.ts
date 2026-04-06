import * as Buf from '../util/buffer.ts';

export const readBoundedBody = async (
    request: Request,
    maxBytes: number,
): Promise<Uint8Array | null> => {
    if (!request.body) {
        return new Uint8Array(0);
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        total += value.byteLength;
        if (total > maxBytes) {
            reader.cancel();
            return null;
        }

        chunks.push(value);
    }

    return Buf.cat(...chunks);
};

export const readBoundedBodyWithTimeout = async (
    request: Request,
    maxBytes: number,
    timeoutMs: number,
) => {
    let timeoutId;
    const expiry = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
            () => reject(new Error("time's up")),
            timeoutMs,
        );
    });

    try {
        return await Promise.race([
            readBoundedBody(request, maxBytes),
            expiry,
        ]);
    } catch {
        request.body?.cancel();
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
};
