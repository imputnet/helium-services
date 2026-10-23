import { setTimeout as delay } from 'node:timers/promises';

import type { Db, ReportRow } from './db.ts';
import type { Config } from './config.ts';
import { logError, logEvent } from './log.ts';
import { normalizeAppleCrashReport } from './applecrash.ts';
import { deleteReportAndPayload } from './reports.ts';
import { crashDiscardReason } from './report-policy.ts';
import { indexReportResponse } from './report-search.ts';
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

interface WorkerDeps {
    db: Db;
    config: Config;
    fetchFn?: typeof fetch;
    pollIntervalMs?: number;
    signal?: AbortSignal;
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
            signal: deps.signal,
        };
        const raw = await Deno.readFile(dumpPath(config.dataDir, report.id));
        const resp =
            report.kind === 'apple'
                ? await symbolicateAppleCrashReport(
                      config.symbolicatorUrl,
                      normalizeAppleCrashReport(new TextDecoder().decode(raw)),
                      opts,
                  )
                : await symbolicateMinidump(config.symbolicatorUrl, raw, opts);
        if (resp.status === 'failed') {
            deleteReportAndPayload(db, config, report.id);
            logEvent('report_rejected', {
                report_id: report.id,
                attempts,
            });
            return;
        }
        const discardReason = crashDiscardReason(resp);
        if (discardReason) {
            deleteReportAndPayload(db, config, report.id);
            logEvent('report_discarded_non_actionable', {
                report_id: report.id,
                reason: discardReason,
                attempts,
            });
            return;
        }
        await writeFileWithDirs(
            processedPath(config.dataDir, report.id),
            JSON.stringify(resp),
        );

        const productHint = report.product?.replace(/_Mac$/i, '');
        const hints = ['chrome', ...(productHint ? [productHint] : [])];
        const sig =
            (await computeSignature(resp, {
                topN: config.signatureFrames,
                appHints: hints,
            })) ?? (await fallbackSignature(resp));
        const now = Date.now();
        const platform = platformFromResponse(resp);
        indexReportResponse(db, report.id, resp);
        const groupId = db.upsertGroup(sig.signature, sig.title, now);
        db.markProcessed(
            report.id,
            groupId,
            platform,
            now,
            sig.symbolicated,
            attempts,
        );
        db.recountGroups([report.group_id, groupId]);

        logEvent('report_processed', {
            report_id: report.id,
            group_id: groupId,
            product: report.product,
            version: report.version,
            platform,
            symbolicated: sig.symbolicated,
            attempts,
        });
    } catch (err) {
        if (deps.signal?.aborted) {
            // Service shutdown is not a processing failure and must not consume
            // the report's final retry. Make it immediately claimable on boot.
            db.markRetry(
                report.id,
                'processing interrupted by shutdown',
                report.attempts,
                0,
            );
            logEvent('report_requeued_shutdown', { report_id: report.id });
            return;
        }

        if (attempts >= config.maxAttempts) {
            deleteReportAndPayload(db, config, report.id);
            logError('report_discarded', err, {
                report_id: report.id,
                attempts,
            });
            return;
        }

        const message = err instanceof Error ? err.message : String(err);
        db.markRetry(
            report.id,
            message,
            attempts,
            Date.now() + backoffMs(attempts),
        );
        logError('report_retry', err, { report_id: report.id, attempts });
    }
}

export function startWorker(deps: WorkerDeps) {
    const controller = new AbortController();
    const signal = deps.signal
        ? AbortSignal.any([controller.signal, deps.signal])
        : controller.signal;
    const workerDeps = { ...deps, signal };
    const requeued = deps.db.resetProcessing();
    if (requeued > 0) {
        logEvent('worker_requeued_stuck', { count: requeued });
    }

    const loop = (async () => {
        while (!signal.aborted) {
            let report: ReportRow | null = null;
            try {
                report = deps.db.claimNext(Date.now());
            } catch (err) {
                logError('worker_claim_error', err);
            }

            if (!report) {
                await delay(deps.config.workerPollMs, undefined, {
                    signal,
                }).catch((err) => {
                    if (!signal.aborted) throw err;
                });
                continue;
            }

            try {
                await processReport(workerDeps, report);
            } catch (err) {
                // A secondary failure (usually a database write) should not
                // permanently terminate the only processing loop.
                logError('worker_process_error', err, {
                    report_id: report.id,
                });
                if (signal.aborted) break;
                try {
                    deps.db.markRetry(
                        report.id,
                        'worker failed to persist processing state',
                        report.attempts,
                        Date.now() + deps.config.workerPollMs,
                    );
                } catch (retryErr) {
                    logError('worker_requeue_error', retryErr, {
                        report_id: report.id,
                    });
                }
            }
        }
    })();

    return {
        stop() {
            controller.abort();
            return loop;
        },
    };
}
