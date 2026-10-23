export const respondWithError = (
    e: unknown,
    format = (_status: number, text: string) => text,
) => {
    const headers = { 'content-type': 'text/plain' };

    if (typeof e === 'string') {
        e = { status: 400, text: e };
    }

    if (e instanceof Object && 'status' in e && 'text' in e) {
        const status = e.status as number;
        return new Response(format(status, e.text as string), {
            status,
            headers,
        });
    }

    return new Response('server error', { status: 500, headers });
};
