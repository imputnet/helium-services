import { assert, assertEquals, assertRejects } from '@std/assert';

import { symbolicateMinidump } from '../src/symbolicator.ts';
import { minimalMinidump } from './helpers.ts';

const completed = { status: 'completed', stacktraces: [] };

function abortingFetch(
    inspect: (signal: AbortSignal, url: string) => void = () => {},
): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        assert(signal instanceof AbortSignal);
        const url = String(input);
        inspect(signal, url);
        return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
            });
        });
    }) as typeof fetch;
}

Deno.test('Symbolicator deadline covers the initial POST', async () => {
    const signals: AbortSignal[] = [];
    const err = await assertRejects(() =>
        symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
            fetchFn: abortingFetch((signal) => signals.push(signal)),
            maxWaitMs: 10,
        }),
    );
    assert(signals[0].aborted);
    assert(err instanceof Error);
    assertEquals(err.name, 'TimeoutError');
});

Deno.test('Symbolicator deadline remains active while reading POST JSON', async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        assert(signal instanceof AbortSignal);
        signals.push(signal);
        const body = new ReadableStream({
            start(controller) {
                signal.addEventListener(
                    'abort',
                    () => controller.error(signal.reason),
                    { once: true },
                );
            },
        });
        return Promise.resolve(
            new Response(body, {
                headers: { 'content-type': 'application/json' },
            }),
        );
    }) as typeof fetch;

    const err = await assertRejects(() =>
        symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
            fetchFn,
            maxWaitMs: 10,
        }),
    );
    assert(signals[0].aborted);
    assert(err instanceof Error);
    assertEquals(err.name, 'TimeoutError');
});

Deno.test('Symbolicator deadline aborts an excessive retry_after', async () => {
    let calls = 0;
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
        assert(init?.signal instanceof AbortSignal);
        calls++;
        return Promise.resolve(
            Response.json({
                status: 'pending',
                request_id: 'request-1',
                retry_after: 60,
            }),
        );
    }) as typeof fetch;

    const err = await assertRejects(() =>
        symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
            fetchFn,
            maxWaitMs: 10,
        }),
    );
    assertEquals(calls, 1);
    assert(err instanceof Error);
    assertEquals(err.name, 'AbortError');
});

Deno.test('Symbolicator reuses one deadline signal for POST and polling', async () => {
    const signals: AbortSignal[] = [];
    const urls: string[] = [];
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        assert(signal instanceof AbortSignal);
        signals.push(signal);
        urls.push(String(input));
        if (signals.length === 1) {
            return Promise.resolve(
                Response.json({
                    status: 'pending',
                    request_id: 'request-1',
                    retry_after: 0,
                }),
            );
        }
        return Promise.resolve(Response.json(completed));
    }) as typeof fetch;

    const result = await symbolicateMinidump(
        'http://symbolicator.test',
        minimalMinidump(),
        { fetchFn, maxWaitMs: 1000 },
    );
    assertEquals(result.status, 'completed');
    assertEquals(signals.length, 2);
    assert(signals[0] === signals[1]);
    assertEquals(urls, [
        'http://symbolicator.test/minidump?timeout=300&scope=minidumpster',
        'http://symbolicator.test/requests/request-1?timeout=300',
    ]);
});

Deno.test('Symbolicator HTTP errors do not expose response details', async () => {
    const err = await assertRejects(
        () =>
            symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
                fetchFn: (() =>
                    Promise.resolve(
                        new Response('sensitive upstream detail', {
                            status: 400,
                        }),
                    )) as typeof fetch,
            }),
        Error,
        'symbolicator POST /minidump failed: 400',
    );
    assert(!err.message.includes('sensitive upstream detail'));
});

Deno.test('Symbolicator deadline covers a hanging poll request', async () => {
    let postSignal: AbortSignal | null = null;
    let pollSignal: AbortSignal | null = null;
    let calls = 0;
    const pendingThenHang = ((
        input: string | URL | Request,
        init?: RequestInit,
    ) => {
        const signal = init?.signal;
        assert(signal instanceof AbortSignal);
        calls++;
        if (calls === 1) {
            postSignal = signal;
            return Promise.resolve(
                Response.json({
                    status: 'pending',
                    request_id: 'request-1',
                    retry_after: 0,
                }),
            );
        }
        return abortingFetch((seen, url) => {
            pollSignal = seen;
            assert(url.includes('/requests/request-1'));
        })(input, init);
    }) as typeof fetch;

    const err = await assertRejects(() =>
        symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
            fetchFn: pendingThenHang,
            maxWaitMs: 10,
        }),
    );
    assert(postSignal === pollSignal);
    assert(err instanceof Error);
    assertEquals(err.name, 'TimeoutError');
});
