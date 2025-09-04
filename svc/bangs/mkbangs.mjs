#!/usr/bin/env node
const VERSION = '202509020031';
const BANG_CHECKSUM = '81444f4418c125f44f0e1222a6747376e0f32a040e13c09865114b14ed4a5dfc';

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
    const handleBang = ({ s, t, u, sc }) => {
        const transformedURL = u.replace(/{{{s}}}/g, '{searchTerms}');
        if (!u.includes('{{{s}}}') || transformedURL.includes('{{{s}}}')) {
            throw `malformed url for ${t}: ${u}`
        }

        t = t.toLowerCase();

        if (seen.has(t)) {
            throw `duplicate bang key: !${t}`;
        }

        seen.add(t);

        return {
            s,
            t,
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
            new URL(u);
            return true;
        } catch {}
    }).flatMap(bang => {
        // TODO: after enough time has passed, stop unrolling
        // all `ts` into separate bangs, and instead just flatten
        // any existing `t` into it
        return [
            bang,
            ...(bang.ts ?? []).map(t => ({ ...bang, t }))
        ];
    }).map(handleBang);

    const extraBangs = extras.flatMap(bang => {
        if (Array.isArray(bang.t)) {
            return bang.t.map(t => ({ ...bang, t }));
        }

        return [ bang ];
    }).map(handleBang);

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
    ].join('\n');
}

const sort = ({ bangs, ...rest }) => {
    bangs.sort((a, b) => {
        a = a.t;
        b = b.t;

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
