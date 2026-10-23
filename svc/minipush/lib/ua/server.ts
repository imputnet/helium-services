import * as g_state from './state.ts';
import * as HTTP from '../util/http.ts';
import { CloseStatus } from '../rfc/6455.ts';
import { handleMessage } from './handlers.ts';
import type { ConnectionState } from './state.ts';
import type { ServerMessage } from './server-schema.ts';
import { type ClientMessage, clientMessage } from './client-schema.ts';

import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const waitForHelloTimeout = (state: ConnectionState) => {
    state.helloTimeoutId = setTimeout(() => {
        state.ws.close(CloseStatus.TIMED_OUT, 'timed out waiting for hello');
    }, 10_000).unref();
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
                g_state.onClientReady(state);
            }
        }
    } catch {
        const { readyState } = state.ws;
        if (
            readyState === WebSocket.CLOSED
            || readyState === WebSocket.CLOSING
        ) {
            return;
        }

        state.ws.close(CloseStatus.INTERNAL_ERROR);
    }
};

const handleWebsocketData = async (state: ConnectionState, raw: unknown) => {
    let success = false,
        data;
    try {
        const obj = JSON.parse(raw as string);
        const parsed = await clientMessage.safeParseAsync(obj);
        success = parsed.success;
        data = parsed.data;
    } catch {
        // fail via !success
    }

    if (!success) {
        state.ws.close(CloseStatus.PROTOCOL_ERROR, 'invalid data');
        return;
    }

    assert(data);

    if (data.messageType === 'hello' && state.helloTimeoutId) {
        clearTimeout(state.helloTimeoutId);
        delete state.helloTimeoutId;
    }

    await handleWebsocketMessage(state, data);
};

export const handleWebsocketConnection = (ws: WebSocket) => {
    const state = g_state.newConnection(ws);
    waitForHelloTimeout(state);

    ws.on('message', (data, isBinary) =>
        handleWebsocketData(state, isBinary ? undefined : String(data)),
    );
    ws.on('close', () => g_state.onClientDisconnected(state));
    // 'close' follows any error, and ws would throw without a listener
    ws.on('error', () => {});
};

export const handleWebsocketSetup = (
    req: Request,
    acceptUpgrade?: () => void,
) => {
    if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response(null, { status: HTTP.status.UPGRADE_REQUIRED });
    }

    const maybeError = HTTP.checkMethod(req, 'GET');
    if (maybeError) return maybeError;

    if (!acceptUpgrade) {
        return new Response(null, { status: HTTP.status.UPGRADE_REQUIRED });
    }

    acceptUpgrade();
    return new Response(null);
};
