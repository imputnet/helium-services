import * as z from '@zod/zod';

const channelId = z.uuid();
const broadcastMap = z.record(z.string(), z.string());

// The client->server message schema.
// Refer to autopush-rs/autoconnect/autoconnect-common/src/protocol.rs

export const clientHello = z.object({
    messageType: z.literal('hello'),
    uaid: z.string().max(72).optional(),
    channelIDs: z.array(channelId).optional(),
    broadcasts: broadcastMap.optional(),
});

export const clientRegister = z.object({
    messageType: z.literal('register'),
    channelID: channelId,
    key: z.string().optional(),
});

export const clientUnregister = z.object({
    messageType: z.literal('unregister'),
    channelID: channelId,
    code: z.uint32().optional(),
});

export const clientBroadcastSubscribe = z.object({
    messageType: z.literal('broadcastSubscribe'),
    broadcasts: broadcastMap,
});

const clientAckInner = z.object({
    channelID: z.uuid(),
    version: z.base64url(),
    code: z.int().min(0).max(65535).optional(),
});

export const clientAck = z.object({
    messageType: z.literal('ack'),
    updates: z.array(clientAckInner),
});

export const clientNack = z.object({
    messageType: z.literal('nack'),
    code: z.int32().optional(),
    version: z.base64url(),
});

export const clientPing = z.union([
    z.object({
        messageType: z.literal('ping'),
    }),
    z.object({}).strict(),
]);

export const clientMessage = z.union([
    clientHello,
    clientRegister,
    clientUnregister,
    clientBroadcastSubscribe,
    clientAck,
    clientNack,
    clientPing,
]);

export type ClientHello = z.infer<typeof clientHello>;
export type ClientRegister = z.infer<typeof clientRegister>;
export type ClientUnregister = z.infer<typeof clientUnregister>;
export type ClientBroadcastSubscribe = z.infer<typeof clientBroadcastSubscribe>;
export type ClientAck = z.infer<typeof clientAck>;
export type ClientNack = z.infer<typeof clientNack>;
export type ClientPing = z.infer<typeof clientPing>;
export type ClientMessage = z.infer<typeof clientMessage>;
