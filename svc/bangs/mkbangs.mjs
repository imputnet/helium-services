#!/usr/bin/env node
const VERSION = '202506021504';
const BANG_CHECKSUM = '2f138dc5cd26be6407e20ccdad7bfa1a710d38e348bb097ce1113151ba33f32a';

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

    const strippedBangs = bangs.filter(({ u }) => {
        try {
            new URL(u);
            return true;
        } catch {}
    }).map(handleBang);

    const extraBangs = extras.map(bang => {
        if (Array.isArray(bang.t)) {
            return bang.t.map(t => ({ ...bang, t }));
        }

        return bang;
    }).flat(1).map(handleBang);

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

load().then(transform).then(sort).then(print).then(console.log);
