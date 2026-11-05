export class Expiry<T> {
    #slots = new Map<number, Set<T>>();
    #next: number;
    #size = 0;

    constructor(nowMs = Date.now()) {
        this.#next = Math.floor(nowMs / 1000);
    }

    get size() {
        return this.#size;
    }

    #slotOf(atMs: number) {
        return Math.max(Math.ceil(atMs / 1000), this.#next);
    }

    add(item: T, atMs: number) {
        const slot = this.#slotOf(atMs);
        let set = this.#slots.get(slot);
        if (!set) {
            set = new Set();
            this.#slots.set(slot, set);
        }

        if (!set.has(item)) {
            set.add(item);
            this.#size++;
        }
    }

    delete(item: T, atMs: number) {
        const slot = this.#slotOf(atMs);
        const set = this.#slots.get(slot);
        if (set?.delete(item)) {
            this.#size--;
            if (set.size === 0) {
                this.#slots.delete(slot);
            }
        }
    }

    // Yields (and forgets) every item due at or before `nowMs`.
    *due(nowMs = Date.now()): Generator<T> {
        const last = Math.floor(nowMs / 1000);
        for (; this.#next <= last; this.#next++) {
            const set = this.#slots.get(this.#next);
            if (!set) {
                continue;
            }

            this.#slots.delete(this.#next);
            this.#size -= set.size;
            yield* set;
        }
    }
}
