// The server->client response message schema.
// Refer to autopush-rs/autoconnect/autoconnect-common/src/protocol.rs

type BroadcastMap = {
    [key: string]: string | BroadcastMap;
} | undefined;

type ServerHello = {
    messageType: 'hello';
    uaid: string;
    status: number;
    use_webpush: true;
    broadcasts: BroadcastMap;
};

type ServerRegister = {
    messageType: 'register';
    channelID: string;
    status: number;
    pushEndpoint: string;
};

type ServerUnregister = {
    messageType: 'unregister';
    channelID: string;
    status: number;
};

type ServerBroadcast = {
    messageType: 'broadcast';
    broadcasts: BroadcastMap;
};

export type ServerNotification = {
    messageType: 'notification';
    channelID: string;
    version: string;
    // skip_serializing: timestamp: number;
    // skip_serializing: ttl: number;
    // skip_serializing: topic?: string;
    data?: string;
    // skip_serializing: sortkey_timestamp?: number;
    headers?: Record<string, string>;
    // We do not implement push reliability stuff, so skip all of that.
    // reliability_id?: string;
    // reliable_state?: unknown;
};

type ServerPing = Record<PropertyKey, never>;

export type ServerMessage =
    | ServerHello
    | ServerRegister
    | ServerUnregister
    | ServerBroadcast
    | ServerNotification
    | ServerPing;
