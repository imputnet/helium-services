import type { Db, ReportRow } from './db.ts';
import type { Config } from './config.ts';
import { logError, logEvent } from './log.ts';
import { normalizeAppleCrashReport } from './applecrash.ts';
import { dumpPath, processedPath, writeFileWithDirs } from './paths.ts';
import {
    computeSignature,
    fallbackSignature,
    platformFromResponse,
} from './signature.ts';
import {
    symbolicateAppleCrashReport,
    symbolicateMinidump,
} from './symbolicator.ts';

export interface WorkerDeps {
    db: Db;
    config: Config;
    fetchFn?: typeof fetch;
    pollIntervalMs?: number;
}

function backoffMs(attempts: number): number {
    return Math.min(30_000 * 2 ** (attempts - 1), 60 * 60 * 1000);
}

export async function processReport(
    deps: WorkerDeps,
    report: ReportRow,
): Promise<void> {
    const { db, config } = deps;
    const attempts = report.attempts + 1;
    try {
        const opts = {
            fetchFn: deps.fetchFn,
            pollIntervalMs: deps.pollIntervalMs,
        };
        const raw = await Deno.readFile(dumpPath(config.dataDir, report.id));
        const resp = report.kind === 'apple'
            ? await symbolicateAppleCrashReport(
                config.symbolicatorUrl,
                normalizeAppleCrashReport(new TextDecoder().decode(raw)),
                opts,
            )
            : await symbolicateMinidump(config.symbolicatorUrl, raw, opts);
        await writeFileWithDirs(
            processedPath(config.dataDir, report.id),
            JSON.stringify(resp),
        );

        const hints = report.product ? [report.product] : [];
        const sig = (await computeSignature(resp, {
            topN: config.signatureFrames,
            appHints: hints,
        }))
            ?? (await fallbackSignature(resp));
        const now = Date.now();
        const groupId = db.upsertGroup(sig.signature, sig.title, now);
        db.markProcessed(
            report.id,
            groupId,
            platformFromResponse(resp),
            now,
            sig.symbolicated,
        );
        db.recountGroups([report.group_id, groupId]);

        logEvent('report_processed', {
            report_id: report.id,
            group_id: groupId,
            product: report.product,
            version: report.version,
            platform: platformFromResponse(resp),
            symbolicated: sig.symbolicated,
            attempts,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempts >= config.maxAttempts) {
            db.markFailed(report.id, message, attempts);
            logError('report_failed', err, { report_id: report.id, attempts });
        } else {
            db.markRetry(
                report.id,
                message,
                attempts,
                Date.now() + backoffMs(attempts),
            );
            logError('report_retry', err, { report_id: report.id, attempts });
        }
    }
}

export interface WorkerHandle {
    stop(): Promise<void>;
}

export function startWorker(deps: WorkerDeps): WorkerHandle {
    let stopped = false;
    const requeued = deps.db.resetProcessing();
    if (requeued > 0) {
        logEvent('worker_requeued_stuck', { count: requeued });
    }

    const loop = (async () => {
        while (!stopped) {
            let claimed: ReportRow[] = [];
            try {
                claimed = deps.db.claimPending(4, Date.now());
            } catch (err) {
                logError('worker_claim_error', err);
            }

            for (const report of claimed) {
                if (stopped) {
                    break;
                }
                await processReport(deps, report);
            }

            if (claimed.length === 0) {
                await new Promise((r) =>
                    setTimeout(r, deps.config.workerPollMs)
                );
            }
        }
    })();

    return {
        async stop() {
            stopped = true;
            await loop;
        },
    };
}
