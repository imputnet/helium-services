import { decodeHex, encodeHex } from '@std/encoding/hex';

export const toBytes = (uuid: string) => {
    if (!UUID_SHAPE.test(uuid)) {
        throw `invalid uuid: ${uuid}`;
    }

    return decodeHex(uuid.replaceAll('-', ''));
};

export const fromBytes = (arr: Uint8Array) => {
    if (arr.byteLength !== 16) {
        throw `fromBytesUUID unexpected array length of ${arr.byteLength}`;
    }

    return [
        arr.subarray(0, 4),
        arr.subarray(4, 6),
        arr.subarray(6, 8),
        arr.subarray(8, 10),
        arr.subarray(10),
    ].map(encodeHex).join('-');
};

export const UUID_SHAPE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
