// https://datatracker.ietf.org/doc/html/rfc6455#section-7.4
// https://www.iana.org/assignments/websocket/websocket.xhtml
export const CloseStatus = {
    OK: 1000,
    GOING_AWAY: 1001,
    PROTOCOL_ERROR: 1002,
    UNSUPPORTED_DATA: 1003,
    MALFORMED_DATA: 1007,
    POLICY_VIOLATION: 1008,
    MESSAGE_TOO_BIG: 1009,
    INTERNAL_ERROR: 1011,
    SERVICE_RESTART: 1012,
    TRY_AGAIN_LATER: 1013,
    UNAUTHORIZED: 3000,
    FORBIDDEN: 3003,
    TIMED_OUT: 3008,
} as const;
