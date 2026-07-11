import { join } from '@std/path';

import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { logError, logEvent } from './log.ts';
import { dumpPath, symbolsDir } from './paths.ts';

export async function runRetention(
    db: Db,
    config: Config,
    now: number = Date.now(),
): Promise<number> {
    const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1000;

    let deleted = 0;
    for (const id of db.dumpsOlderThan(cutoff)) {
        try {
            await Deno.remove(dumpPath(config.dataDir, id));
            deleted++;
        } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) {
                logError('retention_delete_error', err, { report_id: id });
                continue;
            }
        }
        db.markDumpDeleted(id);
    }

    if (deleted > 0) {
        logEvent('retention_run', { deleted, cutoff });
    }

    return deleted;
}

export async function runSymbolRetention(
    config: Config,
    now: number = Date.now(),
): Promise<{ bundles: number; debugDirs: number }> {
    const none = { bundles: 0, debugDirs: 0 };
    if (config.symbolsRetentionDays <= 0) {
        return none;
    }

    const cutoff = now - config.symbolsRetentionDays * 24 * 60 * 60 * 1000;
    const root = symbolsDir(config.dataDir);
    const bundlesDir = join(root, 'bundles');

    const expired = new Set<string>();
    try {
        for await (const entry of Deno.readDir(bundlesDir)) {
            if (!entry.isFile) {
                continue;
            }
            const stat = await Deno.stat(join(bundlesDir, entry.name));
            if ((stat.mtime?.getTime() ?? now) < cutoff) {
                expired.add(entry.name);
            }
        }
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            return none;
        }
        throw err;
    }

    if (expired.size === 0) {
        return none;
    }

    let debugDirs = 0;
    for await (const shard of Deno.readDir(root)) {
        if (!shard.isDirectory || shard.name === 'bundles') {
            continue;
        }

        const shardPath = join(root, shard.name);
        for await (const dbg of Deno.readDir(shardPath)) {
            if (!dbg.isDirectory) {
                continue;
            }

            const refsPath = join(shardPath, dbg.name, 'refs');
            let hadRefs = false;
            let remaining = 0;
            try {
                for await (const ref of Deno.readDir(refsPath)) {
                    hadRefs = true;
                    if (expired.has(ref.name)) {
                        await Deno.remove(join(refsPath, ref.name));
                    } else {
                        remaining++;
                    }
                }
            } catch (err) {
                if (err instanceof Deno.errors.NotFound) {
                    continue; // unmanaged dir
                }
                throw err;
            }

            if (hadRefs && remaining === 0) {
                await Deno.remove(join(shardPath, dbg.name), {
                    recursive: true,
                });
                debugDirs++;
            }
        }

        // Drop the two-char shard dir if it is now empty.
        await Deno.remove(shardPath).catch(() => {});
    }

    for (const bundle of expired) {
        await Deno.remove(join(bundlesDir, bundle)).catch(() => {});
    }

    logEvent('symbols_retention_run', {
        bundles: expired.size,
        debug_dirs: debugDirs,
    });

    return { bundles: expired.size, debugDirs };
}

export function startRetentionJob(db: Db, config: Config): () => void {
    const run = () => {
        runRetention(db, config).catch((err) =>
            logError('retention_error', err)
        );
        runSymbolRetention(config).catch((err) =>
            logError('symbols_retention_error', err)
        );
    };

    run();
    const timer = setInterval(run, 24 * 60 * 60 * 1000);

    return () => clearInterval(timer);
}
