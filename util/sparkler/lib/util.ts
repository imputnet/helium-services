import { stat } from 'node:fs/promises';

export const exists = async (path: string) => {
    try {
        await stat(path);
        return true;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }

        throw e;
    }
};

export const arg = (name: string) => {
    const args = process.argv.slice(2);
    const i = args.indexOf(`--${name}`);
    if (i === -1) {
        return false;
    }

    if (args[i + 1] && !args[i + 1].startsWith('--')) {
        return args[i + 1];
    }

    return true;
};

export const decode = (chars: number[]): string => {
    return new TextDecoder().decode(new Uint8Array(chars));
};
