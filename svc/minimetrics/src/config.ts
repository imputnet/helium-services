export interface Config {
    port: number;
    dataDir: string;
    githubClientId: string;
    githubClientSecret: string;
    githubOrg: string;
    sessionSecret: string;
    namesUploadToken: string;
    publicBaseUrl: string;
    maxLogSizeBytes: number;
    maxNamesSizeBytes: number;
    retentionDays: number;
    rateLimitPerMinute: number;
    /** Histogram data is hidden for filters, days and versions with fewer
     * daily users, so small groups can't be singled out. */
    minUsers: number;
    histogramAllowlist: string | null;
}

const REQUIRED = [
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_ORG',
    'SESSION_SECRET',
    'NAMES_UPLOAD_TOKEN',
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

    return {
        port: intEnv(env, 'PORT', 8080),
        dataDir: env['DATA_DIR'] || './data',
        githubClientId: env['GITHUB_CLIENT_ID']!,
        githubClientSecret: env['GITHUB_CLIENT_SECRET']!,
        githubOrg: env['GITHUB_ORG']!,
        sessionSecret: secret,
        namesUploadToken: env['NAMES_UPLOAD_TOKEN']!,
        publicBaseUrl: baseUrl.replace(/\/+$/, ''),
        maxLogSizeBytes: intEnv(env, 'MAX_LOG_SIZE_MB', 10) * 1024 * 1024,
        maxNamesSizeBytes: intEnv(env, 'MAX_NAMES_SIZE_MB', 64) * 1024 * 1024,
        retentionDays: intEnv(env, 'RETENTION_DAYS', 90),
        rateLimitPerMinute: intEnv(env, 'RATE_LIMIT_PER_MINUTE', 30),
        minUsers: intEnv(env, 'MIN_USERS', 5),
        histogramAllowlist: env['HISTOGRAM_ALLOWLIST'] || null,
    };
}

export function devConfig(env: Record<string, string | undefined>): Config {
    const config = loadConfig({
        ...env,
        DATA_DIR: env['DEV_DATA_DIR'] || './.dev-data',
        GITHUB_CLIENT_ID: 'unused-in-dev',
        GITHUB_CLIENT_SECRET: 'unused-in-dev',
        GITHUB_ORG: 'unused-in-dev',
        SESSION_SECRET: 'dev-session-secret-0123',
        NAMES_UPLOAD_TOKEN: 'dev-names-token',
        PUBLIC_BASE_URL: 'http://localhost',
        MIN_USERS: env['MIN_USERS'] || '1',
    });

    return { ...config, publicBaseUrl: `http://localhost:${config.port}` };
}
