export async function checkOrgMembership(
    fetchFn: typeof fetch,
    token: string,
    org: string,
) {
    const res = await fetchFn(
        `https://api.github.com/user/memberships/orgs/${
            encodeURIComponent(org)
        }`,
        {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'minidumpster-crash-service',
                Authorization: `Bearer ${token}`,
            },
        },
    );

    if (!res.ok) {
        return false;
    }

    const data = await res.json() as { state?: string };
    return data.state === 'active';
}

export class GithubHttpError extends Error {
    readonly rateLimited: boolean;

    constructor(
        message: string,
        readonly status: number,
        headers: Headers,
    ) {
        super(message);
        this.name = 'GithubHttpError';
        this.rateLimited = status === 429
            || headers.get('x-ratelimit-remaining') === '0'
            || headers.has('retry-after');
    }
}

export async function githubHttpError(
    context: string,
    response: Response,
): Promise<GithubHttpError> {
    const detail = await response.text().catch(() => '');
    return new GithubHttpError(
        `${context}: ${response.status} ${detail.slice(0, 500)}`,
        response.status,
        response.headers,
    );
}
