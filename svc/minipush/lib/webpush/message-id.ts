import { env } from '../env.ts';
import * as Buf from '../util/buffer.ts';
import * as Crypto from '../util/crypto.ts';
import { UAID_LEN_UNSIGNED } from '../ua/uaid.ts';

// Message ids are used both as the notification `version` sent to the
// client and in the `Location` returned to the application server, so
// they are encrypted to avoid leaking the UAID to (and correlating it
// between) application servers.

const IV_LEN = 12;
const NONCE_LEN = 8;

const key = await (async () => {
    const material = await crypto.subtle.importKey(
        'raw',
        Buf.toBytes(env.endpointSecret),
        'HKDF',
        false,
        ['deriveKey'],
    );

    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(),
            info: Buf.toBytes('minipush message id'),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
})();

export const make = async (uaid: string) => {
    const iv = Crypto.rand(IV_LEN);
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        Buf.cat(Buf.fromBase64Url(uaid), Crypto.rand(NONCE_LEN)),
    );

    return Buf.toBase64Url(Buf.cat(iv, encrypted));
};

// Returns the UAID the message belongs to, throws if the id was not
// issued by us.
export const unwrap = async (id: string) => {
    const bytes = Buf.fromBase64Url(id);
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.subarray(0, IV_LEN) },
        key,
        bytes.subarray(IV_LEN),
    );

    const [uaid] = Buf.split(plain, [UAID_LEN_UNSIGNED, NONCE_LEN]);
    return Buf.toBase64Url(uaid);
};
