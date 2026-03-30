export const toBytes = (s: string) => new TextEncoder().encode(s);

export const cat = (...bufs: (ArrayBuffer | Uint8Array)[]) => {
    let len = 0, written = 0;
    for (const buf of bufs) {
        len += buf.byteLength;
    }

    const out = new Uint8Array(new ArrayBuffer(len));
    for (const buf of bufs) {
        out.set(new Uint8Array(buf), written);
        written += buf.byteLength;
    }

    return out;
};

export const split = (buf: ArrayBuffer, lengths: number[]) => {
    let u8 = new Uint8Array(buf);
    const out = [];

    for (const length of lengths) {
        const chunk = u8.subarray(0, length);
        if (chunk.length !== length && chunk.length > 0) {
            throw `got partial chunk: ${chunk.length}, expected ${length}`;
        }

        out.push(chunk);
        u8 = u8.subarray(length);
    }

    if (u8.length > 0) {
        throw `extraneous data of ${u8.length} bytes at end of buffer`;
    }

    return out;
};
