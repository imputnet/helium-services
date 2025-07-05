export type Enclosure = {
    '@url': string;
    '@length': number;
    '@type': 'application/octet-stream';
    '@sparkle:edSignature': string;
};

export type DeltaEnclosure = Enclosure & {
    '@sparkle:deltaFrom': string;
};

export type AppcastRelease = {
    title: string;
    pubDate: string;
    'sparkle:channel'?: string;
    'sparkle:version': string;
    'sparkle:shortVersionString': string;
    'sparkle:minimumSystemVersion': string;
    enclosure: Enclosure;
    'sparkle:deltas'?: { enclosure: DeltaEnclosure[] };
};

export type Appcast = {
    '@version': '1.0';
    '@standalone': 'yes';
    rss: {
        '@version': '2.0';
        '@xmlns:sparkle': 'http://www.andymatuschak.org/xml-namespaces/sparkle';
        channel: {
            title: string;
            item: AppcastRelease[];
        };
    };
};
