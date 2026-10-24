export const digest = async (str: string) => {
    const u8 = new TextEncoder().encode(str);
    const hashBytes = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(hashBytes)]
        .map((a) => a.toString(16).padStart(2, '0'))
        .join('');
};

export const isValidUrl = (str: unknown) => {
    try {
        const { protocol } = new URL(String(str));

        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
};

export const shotgunFetch = async (
    input: readonly (string | URL | Request)[],
    init?: Omit<RequestInit, 'signal'>,
) => {
    const controller = new AbortController();
    const response = await Promise.any(
        input.map(async (info) => {
            const response = await fetch(info, {
                ...init,
                signal: controller.signal,
            });

            if (response.ok && response.status === 200) {
                const body = await response.arrayBuffer();
                const readyResponse = new Response(body, response);

                return readyResponse;
            } else throw response;
        }),
    );

    controller.abort();

    return response;
};
