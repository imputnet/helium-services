// Minimal protobuf wire-format reader. UMA logs are large and we only need a
// handful of fields, so this avoids pulling in a protobuf runtime and the
// whole metrics_proto schema.

export class ProtoError extends Error {}

export const WireType = {
    Varint: 0,
    Fixed64: 1,
    Len: 2,
    StartGroup: 3,
    EndGroup: 4,
    Fixed32: 5,
} as const;

export type WireType = (typeof WireType)[keyof typeof WireType];

const WIRE_TYPES: readonly WireType[] = Object.values(WireType);

export interface Tag {
    field: number;
    wire: WireType;
}

export class Reader {
    #pos = 0;
    readonly #view: DataView;

    readonly buf: Uint8Array;

    constructor(buf: Uint8Array) {
        this.buf = buf;
        this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    get done(): boolean {
        return this.#pos >= this.buf.byteLength;
    }

    #need(n: number): void {
        if (this.#pos + n > this.buf.byteLength) {
            throw new ProtoError('truncated message');
        }
    }

    varint(): bigint {
        let result = 0n;

        for (let shift = 0n; shift < 70n; shift += 7n) {
            this.#need(1);
            const b = this.buf[this.#pos++];
            result |= BigInt(b & 0x7f) << shift;

            if ((b & 0x80) === 0) {
                return BigInt.asUintN(64, result);
            }
        }

        throw new ProtoError('varint too long');
    }

    int64(): number {
        return Number(BigInt.asIntN(64, this.varint()));
    }

    fixed64(): bigint {
        this.#need(8);
        const v = this.#view.getBigUint64(this.#pos, true);
        this.#pos += 8;

        return v;
    }

    bytes(): Uint8Array {
        const len = Number(this.varint());
        this.#need(len);
        const out = this.buf.subarray(this.#pos, this.#pos + len);
        this.#pos += len;

        return out;
    }

    string(): string {
        return new TextDecoder().decode(this.bytes());
    }

    tag(): Tag {
        const tag = Number(this.varint());
        const field = tag >>> 3;

        if (field === 0) {
            throw new ProtoError('invalid field number 0');
        }

        const wire = WIRE_TYPES.find((w) => w === (tag & 7));

        if (wire === undefined) {
            throw new ProtoError(`invalid wire type ${tag & 7}`);
        }

        return { field, wire };
    }

    skip(wire: WireType): void {
        switch (wire) {
            case WireType.Varint:
                this.varint();

                return;
            case WireType.Fixed64:
                this.#need(8);
                this.#pos += 8;

                return;
            case WireType.Len:
                this.bytes();

                return;
            case WireType.Fixed32:
                this.#need(4);
                this.#pos += 4;

                return;
            default:
                // Groups are deprecated and never used by metrics_proto.
                throw new ProtoError(`unsupported wire type ${wire}`);
        }
    }

    /** Iterates over fields, calling `fn` for each. `fn` must consume the
     * field's value and return true, or return false to have it skipped. */
    fields(fn: (field: number, wire: WireType) => boolean): void {
        while (!this.done) {
            const { field, wire } = this.tag();

            if (!fn(field, wire)) {
                this.skip(wire);
            }
        }
    }
}

export function expectWire(
    actual: WireType,
    expected: WireType,
    what: string,
): void {
    if (actual !== expected) {
        throw new ProtoError(
            `${what}: expected wire type ${expected}, got ${actual}`,
        );
    }
}
