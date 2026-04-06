import * as g_state from './state.ts';
import * as HTTP from '../util/http.ts';
import { CloseStatus } from '../rfc/6455.ts';
import { handleMessage } from './handlers.ts';
import type { ConnectionState } from './state.ts';
import { ServerMessage } from './server-schema.ts';
import { type ClientMessage, clientMessage } from './client-schema.ts';

import { assert } from '@std/assert';

const waitForHelloTimeout = (state: ConnectionState) => {
    state.helloTimeoutId = setTimeout(() => {
        state.ws.close(
            CloseStatus.TIMED_OUT,
            'timed out waiting for hello',
        );
    }, 10_000);

    Deno.unrefTimer(state.helloTimeoutId);
};

const send = (state: ConnectionState, message: ServerMessage) =>
    state.ws.send(JSON.stringify(message));

const handleWebsocketMessage = async (
    state: ConnectionState,
    msg: ClientMessage,
) => {
    try {
        const response = await handleMessage(state, msg);
        if (response !== null) {
            send(state, response);

            if (response.messageType === 'hello') {
                state.ready = true;
            }
        }
    } catch {
        const { CLOSED, CLOSING, readyState } = state.ws;
        if (readyState === CLOSED || readyState === CLOSING) {
            return;
        }

        state.ws.close(CloseStatus.INTERNAL_ERROR);
    }
};

const handleWebsocketConnection = (state: ConnectionState) => {
    const { ws } = state;

    ws.addEventListener('message', async (event) => {
        let success = false, data;
        try {
            const obj = JSON.parse(event.data);
            const parsed = await clientMessage.safeParseAsync(obj);
            success = parsed.success;
            data = parsed.data;
        } catch {
            // fail via !success
        }

        if (!success) {
            ws.close(CloseStatus.PROTOCOL_ERROR, 'invalid data');
            return;
        }

        assert(data);

        if (data.messageType === 'hello' && state.helloTimeoutId) {
            clearTimeout(state.helloTimeoutId);
            delete state.helloTimeoutId;
        }

        await handleWebsocketMessage(state, data);
    });

    ws.addEventListener('close', () => {
        g_state.onClientDisconnected(state);
    });
};

export const handleWebsocketSetup = (req: Request) => {
    if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response(null, { status: HTTP.status.UPGRADE_REQUIRED });
    }

    const maybeError = HTTP.checkMethod(req, 'GET');
    if (maybeError) return maybeError;

    const { socket, response } = Deno.upgradeWebSocket(req);
    const state: ConnectionState = { ws: socket };
    waitForHelloTimeout(state);
    handleWebsocketConnection(state);

    return response;
};
