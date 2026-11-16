export function githubApiHeaders(token: string) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'minimetrics',
    };
}

export async function checkOrgMembership(
    fetchFn: typeof fetch,
    token: string,
    org: string,
) {
    const res = await fetchFn(
        `https://api.github.com/user/memberships/orgs/${
            encodeURIComponent(org)
        }`,
        { headers: githubApiHeaders(token) },
    );

    if (!res.ok) {
        return false;
    }

    const { state } = await res.json();

    return state === 'active';
}
