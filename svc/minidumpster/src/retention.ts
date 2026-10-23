import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { logError, logEvent } from './log.ts';
import { isNotFound, symbolsDir } from './paths.ts';
import { deleteReportPayloads } from './reports.ts';

export function runRetention(
    db: Db,
    config: Config,
    now: number = Date.now(),
): number {
    const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1000;

    const expired = db.deleteExpiredReports(cutoff);
    deleteReportPayloads(config, expired);

    if (expired.length > 0) {
        logEvent('retention_run', { deleted: expired.length, cutoff });
    }

    return expired.length;
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
        for (const entry of await readdir(bundlesDir, {
            withFileTypes: true,
        })) {
            if (!entry.isFile()) {
                continue;
            }
            const { mtimeMs } = await stat(join(bundlesDir, entry.name));
            if (mtimeMs < cutoff) {
                expired.add(entry.name);
            }
        }
    } catch (err) {
        if (isNotFound(err)) {
            return none;
        }
        throw err;
    }

    if (expired.size === 0) {
        return none;
    }

    let debugDirs = 0;
    for (const shard of await readdir(root, { withFileTypes: true })) {
        if (!shard.isDirectory() || shard.name === 'bundles') {
            continue;
        }

        const shardPath = join(root, shard.name);
        for (const dbg of await readdir(shardPath, { withFileTypes: true })) {
            if (!dbg.isDirectory()) {
                continue;
            }

            const refsPath = join(shardPath, dbg.name, 'refs');
            let hadRefs = false;
            let remaining = 0;
            try {
                for (const ref of await readdir(refsPath)) {
                    hadRefs = true;
                    if (expired.has(ref)) {
                        await rm(join(refsPath, ref));
                    } else {
                        remaining++;
                    }
                }
            } catch (err) {
                if (isNotFound(err)) {
                    continue; // unmanaged dir
                }
                throw err;
            }

            if (hadRefs && remaining === 0) {
                await rm(join(shardPath, dbg.name), { recursive: true });
                debugDirs++;
            }
        }

        // Drop the two-char shard dir if it is now empty.
        await rmdir(shardPath).catch(() => {});
    }

    for (const bundle of expired) {
        await rm(join(bundlesDir, bundle)).catch(() => {});
    }

    logEvent('symbols_retention_run', {
        bundles: expired.size,
        debug_dirs: debugDirs,
    });

    return { bundles: expired.size, debugDirs };
}

export function startRetentionJob(db: Db, config: Config): () => void {
    const run = () => {
        try {
            runRetention(db, config);
        } catch (err) {
            logError('retention_error', err);
        }
        runSymbolRetention(config).catch((err) =>
            logError('symbols_retention_error', err),
        );
    };

    run();
    const timer = setInterval(run, 24 * 60 * 60 * 1000);

    return () => clearInterval(timer);
}
