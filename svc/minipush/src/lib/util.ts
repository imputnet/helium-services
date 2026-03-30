export const clamp = (v: number, lo: number, hi: number) =>
    Math.max(Math.min(v, hi), lo);
