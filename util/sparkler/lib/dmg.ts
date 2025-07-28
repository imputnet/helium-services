import SevenZip from 'npm:7z-wasm@1.2.0';
import { parse } from 'npm:@plist/parse@1.1.0';

import { read } from './assets.ts';
import type { Asset } from '../types/assets.ts';

const getMinimumVersion = async (data: Uint8Array) => {
    const buf: number[] = [];

    const zip = await SevenZip.default({
        stdout: (char: number) => {
            buf.push(char);
        },
    });

    const fd = zip.FS.open('app.dmg', 'w+');
    zip.FS.write(fd, data, 0, data.length);
    zip.FS.close(fd);

    zip.callMain(['l', 'app.dmg']);

    const lines = String.fromCharCode(...buf.splice(0)).split('\n');

    const headerIndex = lines.findIndex((l) => l.includes('Name') && l.includes('Compressed'));
    const nameOffset = lines[headerIndex]?.indexOf('Name');
    if (headerIndex === -1 || nameOffset === -1) {
        throw new Error('could not find 7z listing header');
    }

    lines.splice(0, headerIndex);
    const plistPath = lines.map((l) => l.substring(nameOffset)).find((path) =>
        path.endsWith('/Info.plist')
    );

    if (typeof plistPath !== 'string') {
        throw new Error('could not find info.plist in dmg');
    }

    zip.callMain(['e', 'app.dmg', '-so', plistPath]);

    const plistData = parse(String.fromCharCode(...buf.splice(0)));

    if (
        plistData instanceof Object && 'LSMinimumSystemVersion' in plistData &&
        typeof plistData.LSMinimumSystemVersion === 'string'
    ) {
        return plistData.LSMinimumSystemVersion;
    }

    throw new Error('could not find LSMinimumSystemVersion in dmg');
};

export const getMinimumSystemVersionFor = async (asset: Asset) => {
    return getMinimumVersion(await read(asset));
};
