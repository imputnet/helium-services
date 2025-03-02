#!/usr/bin/env node
const VERSION = '202502241504';
const BANG_CHECKSUM = '0775f7419797256b53d9bd64426e3a03e7e3c091e0d15f355460f492d4598e07';

const prefix = `https://raw.githubusercontent.com/kagisearch/bangs/refs/tags/${VERSION}`;

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
    const license = await fetch(prefix + '/LICENSE').then(a => a.text());

    return { bangs, license }
}

const transform = ({ bangs, license }) => {
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

    const strippedBangs = bangs.filter(({ u }) => {
        try {
            new URL(u);
            return true;
        } catch {}
    }).map(({ s, t, u }) => {
        const transformedURL = u.replace(/{{{s}}}/g, '{searchTerms}');
        if (!u.includes('{{{s}}}') || transformedURL.includes('{{{s}}}')) {
            throw `malformed url for ${t}: ${u}`
        }

        return { s, t, u: transformedURL };
    });

    return [
        ...commentLicense, '',
        JSON.stringify(strippedBangs, null, 1)
    ].join('\n');
}

load().then(transform).then(console.log);
