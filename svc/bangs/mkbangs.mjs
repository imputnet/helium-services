#!/usr/bin/env node
const VERSION = '202602231517';
const BANG_CHECKSUM = '74c237875a515e642797bffc394dd0e09323e8e72f8818bbab5de7f4e2a1be9f';

const SOURCE_URL_PREFIX = `https://raw.githubusercontent.com/kagisearch/bangs/refs/tags/${VERSION}`;

const CATEGORY_MAP = {
    "AI Chatbots": 'ai'
};

// Flags can be deprecated and removed, but their
// values must never be reused.
const FLAGS = {
    OPEN_BASE_PATH          : 1 << 0,
    OPEN_SNAP_DOMAIN        : 1 << 1,
    URL_ENCODE_PLACEHOLDER  : 1 << 2,
    URL_ENCODE_SPACE_TO_PLUS: 1 << 3,
};

const intoFlags = (fmt) => {
    let flags = 0;

    for (const flag of fmt || []) {
        if (!FLAGS[flag.toUpperCase()]) {
            console.warn('[!] missing flag', flag, 'in bit map');
        }

        flags |= FLAGS[flag.toUpperCase()] || 0;
    }

    return flags;
}

const digest = async (str) => {
    const u8 = new TextEncoder().encode(str);
    const hashBytes = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(hashBytes)]
            .map(a => a.toString(16).padStart(2, '0'))
            .join('');
}

const load = async () => {
    const bangText = await fetch(SOURCE_URL_PREFIX + '/data/bangs.json')
                           .then(a => a.text());
    if (await digest(bangText) !== BANG_CHECKSUM) {
        throw `checksum does not match: ${await digest(bangText)}`;
    }

    const bangs = JSON.parse(bangText);
    const extras = await import(
        './extras.json', { with: { type: 'json' } }
    ).then(i => i.default);
    const license = await fetch(
        SOURCE_URL_PREFIX + '/LICENSE').then(a => a.text());

    return { bangs, extras, license }
}

const EXPECTED_KEYS = {
    s: 'string', /* name/site */
    d: 'string', /* domain */
    ad: 'string?', /* alt domain */
    t: 'string', /* trigger */
    ts: 'string[]?', /* extra `t`s */
    u: 'string', /* full "template" URL */
    c: 'string?', /* category */
    sc: 'string?', /* subcategory */
    fmt: 'string[]?', /* format flags */
    skip_tests: 'boolean?', /* undocumented */
    x: 'string?', /* regex pattern */
};

const check_type = (val, type) => {
    if (type.endsWith('?')) {
        if (val === undefined) {
            return;
        }

        type = type.slice(0, -1);
    }

    if (type.endsWith('[]')) {
        type = type.slice(0, -2);
        try {
            val.forEach(v => check_type(v, type));
        } catch(e) {
            throw e + '[]';
        }

        return;
    }

    if (typeof val !== type) {
        throw `expected ${type}, but is actually ${typeof val}`
    }
}

const validate = ({ bangs, ...rest }) => {
    for (const bang of bangs) {
        const unexpected = Object.keys(bang).filter(key => !EXPECTED_KEYS[key]);
        if (unexpected.length) {
            throw `unexpected keys in ${JSON.stringify(bang)}: ${unexpected.join(', ')}`
        }

        for (const [ key, type ] of Object.entries(EXPECTED_KEYS)) {
            check_type(bang[key], type);
        }
    }

    return { bangs, ...rest };
}

const transform = ({ bangs, extras, ...rest }) => {
    const seen = new Set();
    const handleBang = ({ s, t, ts, fmt, u, sc }, dupes) => {
        const transformedURL = u.replace(/{{{s}}}/g, '{searchTerms}');
        if (!u.includes('{{{s}}}') || transformedURL.includes('{{{s}}}')) {
            throw `malformed url for ${t}: ${u}`
        }

        ts ??= [];
        if (t) {
            ts.push(t);
        }

        ts = ts.map(t => t.toLowerCase())
            .filter(t => !dupes || !dupes.has(t))
            .sort((a, b) => {
                return (a.length - b.length) || a.localeCompare(b);
            });

        for (const t of ts) {
            if (seen.has(t))
                throw `duplicate bang key: !${t}`;
            seen.add(t);
        }

        return {
            s,
            ts,
            f: intoFlags(fmt) || undefined,
            u: transformedURL,
            sc: CATEGORY_MAP[sc]
        };
    };

    const extraBangs = extras.map(bang => handleBang(bang));
    const extraTriggers = new Set(seen);

    const strippedBangs = bangs.filter(({ t, u, x }) => {
        if (x) {
            console.error(`[!] skipping unsupported bang !${t} with url ${u}`);
            return false;
        }

        if (u.startsWith('/')) {
            return false;
        }

        try {
            const url = new URL(u);
            if (url.hostname === 'kagi.com' || url.hostname.endsWith('.kagi.com')) {
                return false;
            }
        } catch {}

        return true;
    }).map(bang => {
        const { t, ts } = bang;
        const triggers = [...(ts || []), t].map(t => t.toLowerCase());

        return handleBang(
            bang,
            extraTriggers
        );
    }).filter(bang => bang.ts.length > 0);

    return { bangs: [ ...strippedBangs, ...extraBangs ], ...rest };
}

const print = ({ bangs, license }) => {
    const commentLicense = [
        `Generated at ${new Date().toISOString()}`,
        'DO NOT edit this file manually! This file is automatically generated.',
        'Changes belong in extras.json, or https://github.com/kagisearch/bangs',
        '',
        ...license.split('\n').map(line => {
            if (line.startsWith('Copyright (c)')) {
                line += `, ${new Date().getFullYear()} imput`;
            }
            return line;
        })
    ].map(line => `//${line ? ' ' : ''}${line}`);

    return [
        ...commentLicense, '',
        JSON.stringify(bangs, null, 1)
            .replace(/\[\s*\n\s*(".*?")\s*\n\s*\],/g, '[ $1 ],') // fold one-elem array onto single line
            .replace(/"(\n\s*])/g, '",\$1') // add trailing commas to multi-element trigger arrays
    ].join('\n');
}

const sort = ({ bangs, ...rest }) => {
    bangs.sort((a, b) => {
        a = a.ts[0];
        b = b.ts[0];

        return (a.length - b.length) || a.localeCompare(b);
    });

    return { bangs, ...rest }
}

load()
    .then(validate)
    .then(transform)
    .then(sort)
    .then(print)
    .then(console.log)
    .catch(err => {
        console.error('Error occurred while making bangs.json:', err);
        throw err;
    })
