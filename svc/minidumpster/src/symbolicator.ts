import type { SymbolicatorResponse } from './signature.ts';

export interface SymbolicateOptions {
    fetchFn?: typeof fetch;
    /** Delay between polls when Symbolicator doesn't suggest one. */
    pollIntervalMs?: number;
    /** Give up on one report after this long in the pending/poll loop. */
    maxWaitMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function symbolicateMinidump(
    baseUrl: string,
    dump: Uint8Array,
    opts: SymbolicateOptions = {},
): Promise<SymbolicatorResponse> {
    const form = new FormData();
    form.append(
        'upload_file_minidump',
        new Blob([dump.slice()]),
        'upload_file_minidump.dmp',
    );

    return await submitAndPoll(baseUrl, '/minidump', form, opts);
}

export async function symbolicateAppleCrashReport(
    baseUrl: string,
    reportText: string,
    opts: SymbolicateOptions = {},
): Promise<SymbolicatorResponse> {
    const form = new FormData();
    form.append(
        'apple_crash_report',
        new Blob([reportText]),
        'apple_crash_report.crash',
    );

    return await submitAndPoll(baseUrl, '/applecrashreport', form, opts);
}

async function submitAndPoll(
    baseUrl: string,
    endpoint: string,
    form: FormData,
    opts: SymbolicateOptions,
): Promise<SymbolicatorResponse> {
    const fetchFn = opts.fetchFn ?? fetch;
    const pollIntervalMs = opts.pollIntervalMs ?? 1000;
    const maxWaitMs = opts.maxWaitMs ?? 5 * 60 * 1000;

    const res = await fetchFn(`${baseUrl}${endpoint}`, {
        method: 'POST',
        body: form,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
            `symbolicator POST ${endpoint} failed: ${res.status} ${
                text.slice(0, 500)
            }`,
        );
    }

    let body = await res.json() as SymbolicatorResponse;

    const deadline = Date.now() + maxWaitMs;
    while (body.status === 'pending') {
        if (!body.request_id) {
            throw new Error('symbolicator returned pending without request_id');
        }
        if (Date.now() > deadline) {
            throw new Error('symbolicator request timed out while pending');
        }

        await sleep(
            body.retry_after !== undefined
                ? body.retry_after * 1000
                : pollIntervalMs,
        );

        const poll = await fetchFn(
            `${baseUrl}/requests/${body.request_id}?timeout=30`,
        );
        if (!poll.ok) {
            const text = await poll.text().catch(() => '');
            throw new Error(
                `symbolicator poll failed: ${poll.status} ${
                    text.slice(0, 500)
                }`,
            );
        }

        body = await poll.json() as SymbolicatorResponse;
    }

    if (body.status !== 'completed') {
        throw new Error(
            `symbolication ${body.status}: ${body.message ?? 'no details'}`,
        );
    }

    return body;
}

export async function symbolicatorReachable(
    baseUrl: string,
    fetchFn: typeof fetch = fetch,
): Promise<boolean> {
    try {
        const res = await fetchFn(`${baseUrl}/healthcheck`, {
            signal: AbortSignal.timeout(2000),
        });

        return res.ok;
    } catch {
        return false;
    }
}
