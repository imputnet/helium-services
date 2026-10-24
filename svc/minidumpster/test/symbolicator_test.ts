import assert from 'node:assert/strict';
import { test } from 'node:test';

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

test('Symbolicator deadline covers the initial POST', async () => {
    const signals: AbortSignal[] = [];
    await assert.rejects(
        () =>
            symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
                fetchFn: abortingFetch((signal) => signals.push(signal)),
                maxWaitMs: 10,
            }),
        {
            name: 'TimeoutError',
        },
    );
    assert(signals[0].aborted);
});

test('Symbolicator deadline remains active while reading POST JSON', async () => {
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

    await assert.rejects(
        () =>
            symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
                fetchFn,
                maxWaitMs: 10,
            }),
        {
            name: 'TimeoutError',
        },
    );
    assert(signals[0].aborted);
});

test('Symbolicator deadline aborts an excessive retry_after', async () => {
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

    await assert.rejects(
        () =>
            symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
                fetchFn,
                maxWaitMs: 10,
            }),
        {
            name: 'AbortError',
        },
    );
    assert.equal(calls, 1);
});

test('Symbolicator reuses one deadline signal for POST and polling', async () => {
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
    assert.equal(result.status, 'completed');
    assert.equal(signals.length, 2);
    assert(signals[0] === signals[1]);
    assert.deepStrictEqual(urls, [
        'http://symbolicator.test/minidump?timeout=300&scope=minidumpster',
        'http://symbolicator.test/requests/request-1?timeout=300',
    ]);
});

test('Symbolicator HTTP errors do not expose response details', async () => {
    await assert.rejects(
        () =>
            symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
                fetchFn: (() =>
                    Promise.resolve(
                        new Response('sensitive upstream detail', {
                            status: 400,
                        }),
                    )) as typeof fetch,
            }),
        (err: Error) => {
            assert(
                err.message.includes('symbolicator POST /minidump failed: 400'),
            );
            assert(!err.message.includes('sensitive upstream detail'));
            return true;
        },
    );
});

test('Symbolicator deadline covers a hanging poll request', async () => {
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

    await assert.rejects(
        () =>
            symbolicateMinidump('http://symbolicator.test', minimalMinidump(), {
                fetchFn: pendingThenHang,
                maxWaitMs: 10,
            }),
        {
            name: 'TimeoutError',
        },
    );
    assert(postSignal === pollSignal);
});
