export interface SessionPayload {
    login: string;
    exp: number;
}

// `<exp>.<login>`, with login in GitHub's username alphabet.
const SESSION = /^(\d{1,16})\.([A-Za-z0-9-]{1,39})$/;

export function encodeSession(payload: SessionPayload): string {
    return `${payload.exp}.${payload.login}`;
}

export function decodeSession(
    value: string | false | undefined,
    now: number = Date.now(),
): SessionPayload | null {
    const match = value ? SESSION.exec(value) : null;

    if (!match) {
        return null;
    }

    const exp = Number(match[1]);

    return exp > now ? { login: match[2], exp } : null;
}
