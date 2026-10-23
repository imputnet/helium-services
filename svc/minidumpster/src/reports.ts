import { readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';

import type { Config } from './config.ts';
import type { Db, NewReport } from './db.ts';
import { logError } from './log.ts';
import { dumpPath, processedPath } from './paths.ts';
import type { SymbolicatorResponse } from './signature.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export function reportExpiresAt(
    receivedAt: number,
    retentionDays: number,
): number {
    return receivedAt + retentionDays * DAY_MS;
}

export async function readProcessedResponse(
    dataDir: string,
    reportId: string,
): Promise<SymbolicatorResponse> {
    return JSON.parse(
        await readFile(processedPath(dataDir, reportId), 'utf8'),
    ) as SymbolicatorResponse;
}

/**
 * Insert the row for a dump already stored at dumpPath(report.id), removing
 * the file again if the insert fails so no unreachable dump is left behind.
 */
export function insertReportForStoredDump(
    db: Db,
    config: Config,
    report: NewReport,
): void {
    try {
        db.insertReport(report);
    } catch (err) {
        try {
            rmSync(dumpPath(config.dataDir, report.id), { force: true });
        } catch (deleteErr) {
            logError('report_insert_cleanup_error', deleteErr, {
                report_id: report.id,
            });
        }
        throw err;
    }
}

export function deleteReportAndPayload(
    db: Db,
    config: Config,
    reportId: string,
): void {
    // Delete the database row first so downloads and searches are denied even
    // if file removal fails.
    db.deleteReport(reportId);
    deleteReportPayloads(config, [reportId]);
}

export function deleteReportPayloads(
    config: Config,
    reportIds: Iterable<string>,
): void {
    for (const reportId of reportIds) {
        for (const [kind, path] of [
            ['raw', dumpPath(config.dataDir, reportId)],
            ['processed', processedPath(config.dataDir, reportId)],
        ] as const) {
            try {
                rmSync(path, { force: true });
            } catch (err) {
                logError('report_payload_delete_error', err, {
                    report_id: reportId,
                    kind,
                });
            }
        }
    }
}

export function deleteGroupAndPayloads(
    db: Db,
    config: Config,
    groupId: number,
): string[] | null {
    // Delete all rows atomically before removing files so none of the reports
    // remain accessible if an individual file removal fails.
    const reportIds = db.deleteGroup(groupId);
    if (!reportIds) {
        return null;
    }

    deleteReportPayloads(config, reportIds);

    return reportIds;
}
