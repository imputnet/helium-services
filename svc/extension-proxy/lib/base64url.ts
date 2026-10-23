export const decodeBase64 = (input: string) => {
    return Buffer.from(input, 'base64url');
};

export const encodeBase64 = (input: ArrayBuffer) => {
    return Buffer.from(input).toString('base64url');
};
