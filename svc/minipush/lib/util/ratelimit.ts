export class RateLimiter {
    #limit: number;
    #counts = new Map<string, number>();

    constructor(limit: number, windowMs: number) {
        this.#limit = limit;
        Deno.unrefTimer(setInterval(() => this.#counts.clear(), windowMs));
    }

    take(key: string) {
        const count = (this.#counts.get(key) ?? 0) + 1;
        this.#counts.set(key, count);
        return count <= this.#limit;
    }
}
