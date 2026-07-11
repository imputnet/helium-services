export interface Config {
    port: number;
    dataDir: string;
    symbolicatorUrl: string;
    githubClientId: string;
    githubClientSecret: string;
    githubOrg: string;
    sessionSecret: string;
    symbolUploadToken: string;
    maxDumpSizeBytes: number;
    retentionDays: number;
    symbolsRetentionDays: number;
    publicBaseUrl: string;
    signatureFrames: number;
    maxAttempts: number;
    workerPollMs: number;
    rateLimitPerMinute: number;
    githubArtifactToken: string | null;
    artifactCrawlerPollMs: number;
    artifactCrawlerMaxBytes: number;
    artifactCrawlerMaxAgeDays: number;
    artifactCrawlerNamePattern: string;
}

const REQUIRED = [
    'SYMBOLICATOR_URL',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_ORG',
    'SESSION_SECRET',
    'SYMBOL_UPLOAD_TOKEN',
    'PUBLIC_BASE_URL',
] as const;

function intEnv(
    env: Record<string, string | undefined>,
    name: string,
    fallback: number,
): number {
    const raw = env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }

    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
            `config error: ${name} must be a positive number, got ${
                JSON.stringify(raw)
            }`,
        );
    }
    return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
    const missing = REQUIRED.filter((k) => !env[k]);
    if (missing.length > 0) {
        throw new Error(
            `config error: missing required environment variable(s): ${
                missing.join(', ')
            }`,
        );
    }

    const secret = env['SESSION_SECRET']!;
    if (secret.length < 16) {
        throw new Error(
            'config error: SESSION_SECRET must be at least 16 characters',
        );
    }

    const baseUrl = env['PUBLIC_BASE_URL']!;
    if (!/^https?:\/\//.test(baseUrl)) {
        throw new Error('config error: PUBLIC_BASE_URL must be an http(s) URL');
    }

    const artifactPattern = env['ARTIFACT_CRAWLER_NAME_PATTERN']
        || String
            .raw`(?:^|[-_.])(symbols?|symbolicated|debug(?:-?symbols?)?|dsym|pdb)(?:$|[-_.])`;
    try {
        new RegExp(artifactPattern, 'i');
    } catch (err) {
        throw new Error(
            `config error: ARTIFACT_CRAWLER_NAME_PATTERN is not a valid regular expression: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }

    return {
        port: intEnv(env, 'PORT', 8080),
        dataDir: env['DATA_DIR'] || './data',
        symbolicatorUrl: env['SYMBOLICATOR_URL']!.replace(/\/+$/, ''),
        githubClientId: env['GITHUB_CLIENT_ID']!,
        githubClientSecret: env['GITHUB_CLIENT_SECRET']!,
        githubOrg: env['GITHUB_ORG']!,
        sessionSecret: secret,
        symbolUploadToken: env['SYMBOL_UPLOAD_TOKEN']!,
        maxDumpSizeBytes: intEnv(env, 'MAX_DUMP_SIZE_MB', 20) * 1024 * 1024,
        retentionDays: intEnv(env, 'RETENTION_DAYS', 30),
        symbolsRetentionDays: env['SYMBOLS_RETENTION_DAYS'] === '0'
            ? 0
            : intEnv(env, 'SYMBOLS_RETENTION_DAYS', 180),
        publicBaseUrl: baseUrl.replace(/\/+$/, ''),
        signatureFrames: intEnv(env, 'SIGNATURE_FRAMES', 5),
        maxAttempts: intEnv(env, 'MAX_ATTEMPTS', 5),
        workerPollMs: intEnv(env, 'WORKER_POLL_MS', 3000),
        rateLimitPerMinute: intEnv(env, 'RATE_LIMIT_PER_MINUTE', 30),
        githubArtifactToken: env['GITHUB_ARTIFACT_TOKEN'] || null,
        artifactCrawlerPollMs: intEnv(
            env,
            'ARTIFACT_CRAWLER_POLL_MS',
            15 * 60 * 1000,
        ),
        artifactCrawlerMaxBytes: intEnv(
            env,
            'ARTIFACT_CRAWLER_MAX_MB',
            20480,
        ) * 1024 * 1024,
        artifactCrawlerMaxAgeDays: intEnv(
            env,
            'ARTIFACT_CRAWLER_MAX_AGE_DAYS',
            7,
        ),
        artifactCrawlerNamePattern: artifactPattern,
    };
}
