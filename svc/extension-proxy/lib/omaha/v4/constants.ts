import { deepFreeze } from '../../util.ts';

export const REQUEST_TEMPLATE = deepFreeze({
    '@os': 'win',
    '@updater': 'chrome',
    acceptformat: 'crx3,download,puff,run,xz,zucc',
    apps: [],
    arch: 'x86_64',
    dedup: 'cr',
    domainjoined: false,
    hw: {
        avx: false,
        physmemory: 16,
        sse: false,
        sse2: false,
        sse3: false,
        sse41: false,
        sse42: false,
        ssse3: false,
    },
    ismachine: false,
    os: {
        arch: 'x86_64',
        platform: 'Windows',
        // TODO: find a way to generate this too
        version: '10.0.26100.3476',
    },
    prodversion: '',
    protocol: '4.0',
    requestid: '',
    sessionid: '',
    updaterversion: '0',
});
