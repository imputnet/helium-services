import { assert } from '@std/assert';
import { encodeBase64Url } from '@std/encoding/base64url';

const ROOT = new URL('../', import.meta.url).pathname;

export const freePort = () => {
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const { port } = listener.addr as Deno.NetAddr;
    listener.close();
    return port;
};

const secret = () =>
    encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));

export const sharedSecrets = () => ({
    MINIPUSH_HMAC_SECRET: secret(),
    MINIPUSH_ENDPOINT_SECRET: secret(),
});

export type Node = {
    url: string;
    wsUrl: string;
    proc: Deno.ChildProcess;
    output: () => string;
    stop: (signal?: Deno.Signal) => Promise<Deno.CommandStatus>;
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
    const port = freePort();
    const url = `http://127.0.0.1:${port}/`;
    const proc = new Deno.Command(Deno.execPath(), {
        args: ['run', '-A', 'main.ts'],
        cwd: ROOT,
        env: {
            ...sharedSecrets(),
            MINIPUSH_PORT: String(port),
            MINIPUSH_BASE_URL: url,
            MINIPUSH_RATE_LIMIT: '100000',
            ...env,
        },
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    let output = '';
    const decoder = new TextDecoder();
    const collect = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) {
            output += decoder.decode(chunk);
        }
    };
    const collected = Promise.all([collect(proc.stdout), collect(proc.stderr)]);

    let exited = false;
    const status = proc.status.then(async (s) => {
        exited = true;
        await collected;
        return s;
    });

    const stop = async (signal: Deno.Signal = 'SIGKILL') => {
        if (!exited) {
            try {
                proc.kill(signal);
            } catch {
                // already gone
            }
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

// deno-lint-ignore no-explicit-any
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
