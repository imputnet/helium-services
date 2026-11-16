type LogValue = string | number | boolean | null | undefined;

type LogFields = Record<string, LogValue>;

export function logEvent(event: string, fields: LogFields = {}): void {
    console.log(
        JSON.stringify({ ts: new Date().toISOString(), event, ...fields }),
    );
}

export function logError(
    event: string,
    cause: unknown,
    fields: LogFields = {},
): void {
    console.error(
        JSON.stringify({
            ts: new Date().toISOString(),
            event,
            error: cause instanceof Error ? cause.message : String(cause),
            ...fields,
        }),
    );
}
