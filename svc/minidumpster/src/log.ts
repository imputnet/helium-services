export function logEvent(
    event: string,
    fields: Record<string, unknown> = {},
): void {
    console.log(
        JSON.stringify({ ts: new Date().toISOString(), event, ...fields }),
    );
}

export function logError(
    event: string,
    err: unknown,
    fields: Record<string, unknown> = {},
): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
        JSON.stringify({
            ts: new Date().toISOString(),
            event,
            error: message,
            ...fields,
        }),
    );
}
