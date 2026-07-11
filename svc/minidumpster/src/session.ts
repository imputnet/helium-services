export interface SessionPayload {
    login: string;
    exp: number;
}

export function encodeSession(payload: SessionPayload): string {
    return JSON.stringify(payload);
}

export function decodeSession(
    value: string | false | undefined,
    now: number = Date.now(),
): SessionPayload | null {
    if (!value) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null) {
            return null;
        }

        const { login, exp } = parsed as Record<string, unknown>;
        if (typeof login !== 'string' || typeof exp !== 'number') {
            return null;
        }
        if (exp <= now) {
            return null;
        }

        return { login, exp };
    } catch {
        return null;
    }
}
