import * as path from 'jsr:@std/path/join';

import * as appcast from './lib/appcast.ts';
import * as assets from './lib/assets.ts';
import * as cache from './lib/cache.ts';
import * as util from './lib/util.ts';
import { env } from './lib/env.ts';

import { CPUArchitecture } from './types/assets.ts';

const main = async () => {
    console.log('[/] preparing assets...');
    await assets.ensureAssetsReady();

    const arches: CPUArchitecture[] = ['arm64', 'x86_64'];
    for (const arch of arches) {
        const appcastPath = path.join(env.appcastDirectory, `appcast-${arch}.xml`);
        await cache.loadExistingAppcast(appcastPath);

        console.log('[/] writing appcast for arch', arch);
        await Deno.writeTextFile(
            appcastPath,
            await appcast.makeAppcast(arch),
        );
    }

    await assets.cleanup();
    console.log('[/] done');
};

if (import.meta.main) {
    await main();
    if (!util.arg('oneshot')) {
        setInterval(main, 1000 * 60 * 60);
    }
}
