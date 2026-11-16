import { dayOf, type Db } from './db.ts';
import type { Config } from './config.ts';
import { logError, logEvent } from './log.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function runMaintenance(
    db: Db,
    config: Config,
    now: number = Date.now(),
): void {
    const today = dayOf(now);

    const finalized = db.finalizeDaysBefore(today);
    const expired = db.deleteBeforeDay(today - config.retentionDays);
    // Log fingerprints go with the day's salt and client hashes. Retries
    // arrive within minutes, so the rare one that crosses midnight UTC is
    // counted twice rather than keeping fingerprints around longer.
    const seen = db.deleteSeenBefore(today * DAY_MS);

    if (finalized + expired + seen > 0) {
        logEvent('maintenance_run', {
            client_hashes_dropped: finalized,
            rows_expired: expired,
            seen_logs_dropped: seen,
        });
    }
}

export function startMaintenanceJob(db: Db, config: Config): () => void {
    const tick = () => {
        try {
            runMaintenance(db, config);
        } catch (err) {
            logError('maintenance_error', err);
        }
    };

    tick();
    // Hourly, so a day's salt, client hashes and log fingerprints outlive the
    // day by at most an hour.
    const id = setInterval(tick, HOUR_MS);

    return () => clearInterval(id);
}
