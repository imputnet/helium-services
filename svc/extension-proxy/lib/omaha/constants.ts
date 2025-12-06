export const REQUEST_TEMPLATE = {
    '@os': 'win',
    '@updater': 'chromecrx',
    acceptformat: 'crx3,puff',
    app: [],
    arch: 'x86',
    dedup: 'cr',
    domainjoined: false,
    hw: {
        avx: false,
        physmemory: 4,
        sse: false,
        sse2: false,
        sse3: false,
        sse41: false,
        sse42: false,
        ssse3: false,
    },
    ismachine: false,
    nacl_arch: 'x86-64',
    os: {
        arch: 'x86_64',
        platform: 'Windows',
        // TODO: find a way to generate this too
        version: '10.0.26100.3476',
    },
    updater: {
        name: 'chromecrx',
        ismachine: false,
        autoupdatecheckenabled: true,
        updatepolicy: 0,
        version: '',
    },
    prodversion: '',
    protocol: '3.1',
    requestid: '',
    sessionid: '',
    updaterversion: '',
    wow64: true,
};

export const OMAHA_JSON_PREFIX = ")]}'";

export const MAX_EXTENSIONS_PER_REQUEST = 100;

export const UPDATE_SERVICES = {
    CHROME_WEBSTORE: 'https://clients2.google.com/service/update2/json',
    CHROME_COMPONENTS: 'https://clients2.google.com/service/update2/json',
};

export type ServiceId = keyof typeof UPDATE_SERVICES;

export const CHROME_WEBSTORE_SNIPPET =
    'https://chromewebstore.googleapis.com/v2/items/{}:fetchItemSnippet';
