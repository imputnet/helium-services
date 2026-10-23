import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { type AddressInfo, createServer } from 'node:net';
import * as Buf from '../lib/util/buffer.ts';

const ROOT = new URL('../', import.meta.url).pathname;

export const freePort = async () => {
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address() as AddressInfo;
    listener.close();
    return port;
};

const secret = () =>
    Buf.toBase64Url(crypto.getRandomValues(new Uint8Array(24)));

export const sharedSecrets = () => ({
    MINIPUSH_HMAC_SECRET: secret(),
    MINIPUSH_ENDPOINT_SECRET: secret(),
});

export type Node = {
    url: string;
    wsUrl: string;
    proc: ChildProcess;
    output: () => string;
    stop: (signal?: NodeJS.Signals) => Promise<number | null>;
};

export const waitFor = async (
    check: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
    what = 'condition',
) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) {
            return;
        }
        await new Promise((r) => setTimeout(r, 25));
    }

    throw new Error(`timed out waiting for ${what}`);
};

export const startNode = async (
    env: Record<string, string> = {},
): Promise<Node> => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const proc = spawn(process.execPath, ['main.ts'], {
        cwd: ROOT,
        env: {
            ...process.env,
            ...sharedSecrets(),
            MINIPUSH_PORT: String(port),
            MINIPUSH_BASE_URL: url,
            MINIPUSH_RATE_LIMIT: '100000',
            ...env,
        },
    });

    let output = '';
    for (const stream of [proc.stdout, proc.stderr]) {
        stream.setEncoding('utf8').on('data', (chunk) => (output += chunk));
    }

    let exited = false;
    const status = once(proc, 'close').then(([code]) => {
        exited = true;
        return code as number | null;
    });

    const stop = async (signal: NodeJS.Signals = 'SIGKILL') => {
        if (!exited) {
            proc.kill(signal);
        }
        return await status;
    };

    try {
        await waitFor(
            async () => {
                if (exited) {
                    throw new Error(`node exited early:\n${output}`);
                }

                try {
                    const res = await fetch(`${url}healthcheck`);
                    await res.body?.cancel();
                    return res.ok;
                } catch {
                    return false;
                }
            },
            10_000,
            'node to start',
        );
    } catch (e) {
        await stop();
        throw e;
    }

    return {
        url,
        wsUrl: url.replace(/^http/, 'ws'),
        proc,
        output: () => output,
        stop,
    };
};

type Json = any;

export class FakeUA {
    ws: WebSocket;
    closed: Promise<CloseEvent>;
    closeEvent?: CloseEvent;
    #inbox: Json[] = [];
    #waiters: (() => void)[] = [];

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.addEventListener('message', (e) => {
            this.#inbox.push(JSON.parse(e.data));
            this.#waiters.splice(0).forEach((w) => w());
        });
        this.closed = new Promise((resolve) => {
            ws.addEventListener('close', (e) => {
                this.closeEvent = e;
                this.#waiters.splice(0).forEach((w) => w());
                resolve(e);
            });
        });
    }

    static async connect(url: string) {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        return new FakeUA(ws);
    }

    send(message: Json) {
        this.ws.send(JSON.stringify(message));
    }

    // Waits for the next message matching `predicate`, removing it from
    // the inbox. Messages which do not match are left alone.
    async next(
        predicate: (m: Json) => boolean = () => true,
        timeoutMs = 5000,
    ): Promise<Json> {
        const deadline = Date.now() + timeoutMs;
        while (true) {
            const idx = this.#inbox.findIndex(predicate);
            if (idx !== -1) {
                return this.#inbox.splice(idx, 1)[0];
            }

            if (this.closeEvent) {
                throw new Error(
                    `socket closed (${this.closeEvent.code}) while waiting`,
                );
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error('timed out waiting for message');
            }

            await new Promise<void>((resolve) => {
                const id = setTimeout(resolve, remaining);
                this.#waiters.push(() => {
                    clearTimeout(id);
                    resolve();
                });
            });
        }
    }

    // Asserts that no message matching `predicate` arrives within `ms`.
    async none(predicate: (m: Json) => boolean = () => true, ms = 300) {
        try {
            const m = await this.next(predicate, ms);
            throw new Error(`unexpected message: ${JSON.stringify(m)}`);
        } catch (e) {
            if (!(e instanceof Error) || !e.message.startsWith('timed out')) {
                throw e;
            }
        }
    }

    notification(timeoutMs?: number) {
        return this.next((m) => m.messageType === 'notification', timeoutMs);
    }

    async hello(uaid?: string, channelIDs?: string[]) {
        this.send({ messageType: 'hello', uaid, channelIDs });
        const res = await this.next((m) => m.messageType === 'hello');
        assert(res.status === 200, `hello failed: ${JSON.stringify(res)}`);
        return res.uaid as string;
    }

    async register(channelID = crypto.randomUUID()) {
        this.send({ messageType: 'register', channelID });
        const res = await this.next(
            (m) => m.messageType === 'register' && m.channelID === channelID,
        );
        assert(res.status === 200, `register failed: ${JSON.stringify(res)}`);
        return { channelID, endpoint: res.pushEndpoint as string };
    }

    ack(...notifications: Json[]) {
        this.send({
            messageType: 'ack',
            updates: notifications.map((n) => ({
                channelID: n.channelID,
                version: n.version,
            })),
        });
    }

    close() {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
        return this.closed;
    }
}

export const push = async (
    endpoint: string,
    body?: string,
    headers: Record<string, string> = {},
) => {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: body
            ? {
                  'content-encoding': 'aes128gcm',
                  ttl: '30',
                  ...headers,
              }
            : { ttl: '30', ...headers },
        body,
    });
    await res.body?.cancel();
    return res;
};
