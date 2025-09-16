#!/usr/bin/env node
const VERSION = '202509151504';
const BANG_CHECKSUM = 'c9b64800b38620fdfd9269bb263d460a13cd55493853f2e25b2ae407d678bc69';

const prefix = `https://raw.githubusercontent.com/kagisearch/bangs/refs/tags/${VERSION}`;

const categoryMap = {
    "AI Chatbots": 'ai'
}

const digest = async (str) => {
    const u8 = new TextEncoder().encode(str);
    const hashBytes = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(hashBytes)]
            .map(a => a.toString(16).padStart(2, '0'))
            .join('');
}

const load = async () => {
    const bangText = await fetch(prefix + '/data/bangs.json').then(a => a.text());
    if (await digest(bangText) !== BANG_CHECKSUM) {
        throw `checksum does not match: ${await digest(bangText)}`;
    }

    const bangs = JSON.parse(bangText);
    const extras = await import(
        './extras.json', { with: { type: 'json' } }
    ).then(i => i.default);
    const license = await fetch(prefix + '/LICENSE').then(a => a.text());

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
    const handleBang = ({ s, t, ts, u, sc }) => {
        const transformedURL = u.replace(/{{{s}}}/g, '{searchTerms}');
        if (!u.includes('{{{s}}}') || transformedURL.includes('{{{s}}}')) {
            throw `malformed url for ${t}: ${u}`
        }

        ts ??= [];
        if (t) {
            ts.push(t);
        }

        ts = ts.map(t => t.toLowerCase()).sort((a, b) => {
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
            u: transformedURL,
            sc: categoryMap[sc]
        };
    };

    const strippedBangs = bangs.filter(({ t, u, x }) => {
        if (x) {
            console.error(`[!] skipping unsupported bang !${t} with url ${u}`);
            return false;
        }

        try {
            const url = new URL(u);
            return url.hostname !== 'kagi.com' && !url.hostname.endsWith('kagi.com');
        } catch {}
    }).map(handleBang);

    const extraBangs = extras.map(handleBang);

    return { bangs: [ ...strippedBangs, ...extraBangs ], ...rest };
}

const print = ({ bangs, license }) => {
    const commentLicense = [
        `Generated at ${new Date().toISOString()}`,
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
        /* todo: uncomment this after 0.5.x:
            .replace(/"(\n\s*])/g, '",\$1') */
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
