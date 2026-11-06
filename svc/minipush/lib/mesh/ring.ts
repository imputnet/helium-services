// 32-bit FNV-1a offset basis and prime.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Knuth's multiplicative hashing constant, a prime close to 2^32 / φ.
const KNUTH = 0x9e3779b1;

// Murmur3's 32-bit finalizer, FNV-1a alone doesn't mix its bits well.
const fmix32 = (h: number) => {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
};

export const hash = (s: string) => {
    let h = FNV_OFFSET_BASIS;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, FNV_PRIME);
    }

    return fmix32(h);
};

export class Ring {
    #members: { id: string; seed: number }[];

    constructor(members: Iterable<string>) {
        this.#members = [...new Set(members)].map((id) => ({
            id,
            seed: hash(id),
        }));
    }

    get size() {
        return this.#members.length;
    }

    rank(key: string): string[] {
        const k = hash(key);
        return this.#members
            .map(({ id, seed }) => ({
                id,
                score: fmix32(Math.imul(k ^ seed, KNUTH)),
            }))
            .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
            .map(({ id }) => id);
    }
}
