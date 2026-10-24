export const optional = (name: string) => process.env[name] || undefined;

export const required = (name: string) => {
    const value = optional(name);
    if (value === undefined) {
        throw new Error(`env ${name} is missing`);
    }

    return value;
};

const TRUTHY = ['1', 'true', 'yes', 'y', 't', 'on'];

export const bool = (name: string, fallback = false) => {
    const value = optional(name);
    if (value === undefined) {
        return fallback;
    }

    return TRUTHY.includes(value.toLowerCase());
};

export const number = (name: string, fallback?: number) => {
    const value = optional(name);
    if (value === undefined) {
        if (fallback === undefined) {
            throw new Error(`env ${name} is missing`);
        }

        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`env ${name} is not a number: ${value}`);
    }

    return parsed;
};

export const url = (name: string) => {
    const value = optional(name);
    if (value !== undefined) {
        return new URL(value);
    }
};
