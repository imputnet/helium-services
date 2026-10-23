import { setTimeout as delay } from 'node:timers/promises';
import { logError } from './log.ts';
import type { SymbolicatorResponse } from './signature.ts';

const REQUEST_TIMEOUT_SECONDS = 5 * 60;

interface SymbolicateOptions {
    fetchFn?: typeof fetch;
    /** Delay between polls when Symbolicator doesn't suggest one. */
    pollIntervalMs?: number;
    /** Give up on the complete POST and polling operation after this long. */
    maxWaitMs?: number;
    /** Cancel the operation early, such as during service shutdown. */
    signal?: AbortSignal;
}

export function symbolicateMinidump(
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

    return submitAndPoll(baseUrl, '/minidump', form, opts);
}

export function symbolicateAppleCrashReport(
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

    return submitAndPoll(baseUrl, '/applecrashreport', form, opts);
}

async function responseError(context: string, response: Response) {
    const detail = await response.text().catch(() => '');
    logError('symbolicator_http_error', detail.slice(0, 500), {
        context,
        status: response.status,
    });
    return new Error(`${context}: ${response.status}`);
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
    const deadline = AbortSignal.timeout(maxWaitMs);
    const signal = opts.signal
        ? AbortSignal.any([deadline, opts.signal])
        : deadline;

    const res = await fetchFn(
        `${baseUrl}${endpoint}?timeout=${REQUEST_TIMEOUT_SECONDS}&scope=minidumpster`,
        {
            method: 'POST',
            body: form,
            signal,
        },
    );
    if (!res.ok) {
        throw await responseError(`symbolicator POST ${endpoint} failed`, res);
    }

    let body = (await res.json()) as SymbolicatorResponse;

    while (body.status === 'pending') {
        if (!body.request_id) {
            throw new Error('symbolicator returned pending without request_id');
        }
        await delay(
            body.retry_after !== undefined
                ? body.retry_after * 1000
                : pollIntervalMs,
            undefined,
            { signal },
        );

        const poll = await fetchFn(
            `${baseUrl}/requests/${body.request_id}?timeout=${REQUEST_TIMEOUT_SECONDS}`,
            { signal },
        );
        if (!poll.ok) {
            throw await responseError('symbolicator poll failed', poll);
        }

        body = (await poll.json()) as SymbolicatorResponse;
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
