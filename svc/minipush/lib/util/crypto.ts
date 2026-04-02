export const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export const sha256 = (r: Uint8Array<ArrayBuffer>) =>
    crypto.subtle.digest('SHA-256', r);
