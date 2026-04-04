import { ServerNotification } from '../ua/server-schema.ts';

export type NotificationInternal = {
    data: ServerNotification;
    uaid: string;
    ttl: number;
    timestamp: number;
    topic?: string;
    encoding?: string;
    encryption?: string;
    encryptionKey?: string;
    cryptoKey?: string;
    delete?: true;
};

export const expired = (noti: NotificationInternal) => {
    const now = Date.now();
    return now > noti.timestamp + noti.ttl * 1000;
};
