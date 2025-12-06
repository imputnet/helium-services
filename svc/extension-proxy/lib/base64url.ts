import { decodeBase64 as _decode, encodeBase64 as _encode } from '@std/encoding/base64';

export const decodeBase64 = (input: Parameters<typeof _decode>[0]) => {
    return _decode(
        input
            .replaceAll('-', '+')
            .replaceAll('_', '/'),
    );
};

export const encodeBase64 = (input: Parameters<typeof _encode>[0]) => {
    return _encode(input)
        .replaceAll('+', '-')
        .replaceAll('_', '/')
        .replaceAll('=', '');
};
