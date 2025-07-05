export const sleep = (ms: number) =>
    new Promise<void>(
        (resolve) => setTimeout(resolve, ms),
    );

export const beq = (a_: ArrayBuffer, b_: ArrayBuffer) => {
    const a = new Uint8Array(a_);
    const b = new Uint8Array(b_);

    if (a.length !== b.length) {
        return false;
    }

    for (let i = 0; i < a.length; ++i) {
        if (a[i] != b[i]) {
            return false;
        }
    }

    return true;
};

export const arg = (name: string) => {
    const i = Deno.args.indexOf(`--${name}`);
    if (i === -1) {
        return false;
    }

    if (Deno.args[i + 1] && !Deno.args[i + 1].startsWith('--')) {
        return Deno.args[i + 1];
    }

    return true;
};
