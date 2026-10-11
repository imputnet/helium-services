import { DatabaseSync } from 'node:sqlite';

type ReportStatus = 'pending' | 'processing' | 'processed' | 'failed';
type ReportKind = 'minidump' | 'apple';

export interface ReportRow {
    id: string;
    group_id: number | null;
    product: string | null;
    version: string | null;
    platform: string | null;
    guid: string | null;
    ptype: string | null;
    channel: string | null;
    annotations: string;
    status: ReportStatus;
    error: string | null;
    attempts: number;
    next_attempt_at: number;
    received_at: number;
    processed_at: number | null;
    kind: ReportKind;
    symbolicated: number;
}

export interface GroupRow {
    id: number;
    signature: string;
    title: string;
    first_seen: number;
    last_seen: number;
    report_count: number;
}

export interface GroupListRow extends GroupRow {
    products: string | null;
    versions: string | null;
    platforms: string | null;
    unsymbolicated: number;
}

export interface GroupFilter {
    product?: string;
    version?: string;
    platform?: string;
    ptype?: string;
    sort?: 'count' | 'last_seen';
}

export type ChartBreakdown = 'total' | 'version' | 'platform';

export interface ReportDayStat {
    day: string;
    n: number;
    segment: string | null;
}

export interface NewReport {
    id: string;
    product: string | null;
    version: string | null;
    guid: string | null;
    ptype: string | null;
    channel: string | null;
    annotations: string;
    received_at: number;
    kind?: ReportKind;
}

type ArtifactIngestStatus = 'pending' | 'ingested' | 'failed';

export interface ArtifactIngestRow {
    repo: string;
    artifact_id: number;
    release_tag: string;
    artifact_name: string;
    status: ArtifactIngestStatus;
    attempts: number;
    next_attempt_at: number;
    error: string | null;
    ingested_at: number | null;
}

type SqlParam = string | number | bigint | null | Uint8Array;

function functionSearchQuery(query: string): string | null {
    const terms = query.match(/\w+/g);
    return terms?.map((term) => `"${term}"*`).join(' AND ') || null;
}

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  group_id INTEGER,
  product TEXT,
  version TEXT,
  platform TEXT,
  guid TEXT,
  ptype TEXT,
  channel TEXT,
  annotations TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'minidump',
  symbolicated INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_reports_queue
  ON reports(status, next_attempt_at, received_at);
CREATE INDEX IF NOT EXISTS idx_reports_group ON reports(group_id, received_at);
CREATE INDEX IF NOT EXISTS idx_reports_prod_ver ON reports(product, version);
CREATE VIRTUAL TABLE IF NOT EXISTS report_search USING fts5(
  report_id UNINDEXED,
  functions
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  report_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS artifact_ingests (
  repo TEXT NOT NULL,
  artifact_id INTEGER NOT NULL,
  release_tag TEXT NOT NULL,
  artifact_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  ingested_at INTEGER,
  PRIMARY KEY (repo, artifact_id)
);
`;

function migrateSchema(db: DatabaseSync): void {
    const current = Number(
        (db.prepare('PRAGMA user_version').get() as { user_version: number })
            .user_version,
    );
    if (current > SCHEMA_VERSION) {
        throw new Error(
            `database schema version ${current} is newer than supported version ${SCHEMA_VERSION}`,
        );
    }
    if (current === SCHEMA_VERSION) {
        return;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
        if (current < 1) {
            // Replaced by idx_reports_queue in databases created before it.
            db.exec('DROP INDEX IF EXISTS idx_reports_status');

            const legacyColumn = db.prepare(`
                SELECT 1
                FROM pragma_table_info('reports')
                WHERE name = 'dump_deleted'
                LIMIT 1
            `).get();
            if (legacyColumn) {
                db.exec('ALTER TABLE reports DROP COLUMN dump_deleted');
            }
            db.exec('PRAGMA user_version = 1');
        }

        if (current < 2) {
            db.exec(`
                DROP TRIGGER IF EXISTS reports_search_delete;
                CREATE TRIGGER reports_search_delete
                AFTER DELETE ON reports
                BEGIN
                  DELETE FROM report_search WHERE rowid = old.rowid;
                END;
            `);
            db.exec('PRAGMA user_version = 2');
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

export class Db {
    private db: DatabaseSync;

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA busy_timeout = 5000;');
        this.db.exec(SCHEMA);
        migrateSchema(this.db);
    }

    private one<T extends object>(
        sql: string,
        ...params: SqlParam[]
    ): T | null {
        return (this.db.prepare(sql).get(...params) as T | undefined) ?? null;
    }

    private many<T extends object>(sql: string, ...params: SqlParam[]): T[] {
        return this.db.prepare(sql).all(...params) as T[];
    }

    private inWriteTransaction<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    close(): void {
        this.db.close();
    }

    insertReport(r: NewReport): void {
        this.db.prepare(
            `INSERT INTO reports (
                 id, product, version, guid, ptype, channel,
                 annotations, status, received_at, kind
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
            r.id,
            r.product,
            r.version,
            r.guid,
            r.ptype,
            r.channel,
            r.annotations,
            r.received_at,
            r.kind ?? 'minidump',
        );
    }

    getReport(id: string): ReportRow | null {
        return this.one<ReportRow>(`SELECT * FROM reports WHERE id = ?`, id);
    }

    findReportByGuid(guid: string): ReportRow | null {
        return this.one<ReportRow>(
            `SELECT *
             FROM reports
             WHERE guid = ?
             ORDER BY received_at DESC
             LIMIT 1`,
            guid,
        );
    }

    searchReports(query: string, limit = 25): ReportRow[] {
        const q = query.trim().toLowerCase();
        const direct = this.many<ReportRow>(
            `SELECT *
             FROM reports
             WHERE id = ?
                OR lower(guid) = ?
                OR id LIKE ?
                OR lower(guid) LIKE ?
             ORDER BY received_at DESC
             LIMIT ?`,
            q,
            q,
            `${q}%`,
            `${q}%`,
            limit,
        );

        const ftsQuery = functionSearchQuery(q);
        if (!ftsQuery || direct.length >= limit) {
            return direct;
        }

        const fullText = this.many<ReportRow>(
            `SELECT reports.*
             FROM report_search
             JOIN reports ON reports.id = report_search.report_id
             WHERE report_search MATCH ?
               AND reports.status = 'processed'
             ORDER BY report_search.rank, reports.received_at DESC
             LIMIT ?`,
            ftsQuery,
            limit,
        );
        const seen = new Set(direct.map((report) => report.id));

        return direct.concat(
            fullText.filter((report) => !seen.has(report.id)),
        ).slice(0, limit);
    }

    searchGroups(query: string, limit = 25): GroupRow[] {
        const q = query.trim().toLowerCase();
        const ftsQuery = functionSearchQuery(q);
        if (!ftsQuery) {
            return [];
        }

        return this.many<GroupRow>(
            `SELECT *
             FROM groups
             WHERE instr(lower(title), ?) > 0
                OR lower(signature) LIKE ?
                OR id IN (
                    SELECT reports.group_id
                    FROM report_search
                    JOIN reports
                      ON reports.id = report_search.report_id
                    WHERE report_search MATCH ?
                      AND reports.status = 'processed'
                      AND reports.group_id IS NOT NULL
                )
             ORDER BY report_count DESC, last_seen DESC
             LIMIT ?`,
            q,
            `${q}%`,
            ftsQuery,
            limit,
        );
    }

    indexReportFunctions(reportId: string, functions: string): void {
        this.inWriteTransaction(() => {
            const report = this.one<{ rowId: number }>(
                `SELECT rowid AS rowId FROM reports WHERE id = ?`,
                reportId,
            );
            if (!report) {
                throw new Error(`cannot index missing report ${reportId}`);
            }
            this.db.prepare(
                `DELETE FROM report_search
                 WHERE rowid = ?`,
            ).run(report.rowId);
            this.db.prepare(
                `INSERT INTO report_search (rowid, report_id, functions)
                 VALUES (?, ?, ?)`,
            ).run(report.rowId, reportId, functions);
        });
    }

    claimNext(now: number): ReportRow | null {
        return this.one<ReportRow>(
            `UPDATE reports
             SET status = 'processing'
             WHERE id IN (
                 SELECT id
                 FROM reports
                 WHERE status = 'pending'
                   AND next_attempt_at <= ?
                 ORDER BY received_at
                 LIMIT 1
             )
             RETURNING *`,
            now,
        );
    }

    resetProcessing(): number {
        const res = this.db.prepare(
            `UPDATE reports
             SET status = 'pending'
             WHERE status = 'processing'`,
        ).run();

        return Number(res.changes);
    }

    markProcessed(
        id: string,
        groupId: number,
        platform: string | null,
        processedAt: number,
        symbolicated: boolean,
        attempts: number,
    ): void {
        this.db.prepare(
            `UPDATE reports
             SET status = 'processed', group_id = ?, platform = ?,
                 processed_at = ?, symbolicated = ?, attempts = ?,
                 next_attempt_at = 0, error = NULL
             WHERE id = ?`,
        ).run(
            groupId,
            platform,
            processedAt,
            symbolicated ? 1 : 0,
            attempts,
            id,
        );
    }

    requeueUnsymbolicated(
        product: string,
        version: string,
        notBefore: number,
    ): number {
        return this.inWriteTransaction(() => {
            const reports = this.many<{ group_id: number | null }>(
                `SELECT group_id
                 FROM reports
                 WHERE status = 'processed'
                   AND symbolicated = 0
                   AND product = ? COLLATE NOCASE
                   AND version = ?`,
                product,
                version,
            );
            this.db.prepare(
                `UPDATE reports
                 SET status = 'pending', group_id = NULL, attempts = 0,
                     next_attempt_at = ?, error = NULL
                 WHERE status = 'processed'
                   AND symbolicated = 0
                   AND product = ? COLLATE NOCASE
                   AND version = ?`,
            ).run(notBefore, product, version);
            this.recountGroups(reports.map((report) => report.group_id));

            return reports.length;
        });
    }

    markRetry(
        id: string,
        error: string,
        attempts: number,
        nextAttemptAt: number,
    ): void {
        this.db.prepare(
            `UPDATE reports
             SET status = 'pending', error = ?, attempts = ?,
                 next_attempt_at = ?
             WHERE id = ?`,
        ).run(error, attempts, nextAttemptAt, id);
    }

    requeueReport(id: string): boolean {
        return this.inWriteTransaction(() => {
            const report = this.one<{ group_id: number | null }>(
                `SELECT group_id
                 FROM reports
                 WHERE id = ?
                   AND status = 'processed'`,
                id,
            );
            if (!report) {
                return false;
            }

            this.db.prepare(
                `UPDATE reports
                 SET status = 'pending', group_id = NULL, error = NULL,
                     attempts = 0, next_attempt_at = 0
                 WHERE id = ?
                   AND status = 'processed'`,
            ).run(id);
            this.recountGroups([report.group_id]);

            return true;
        });
    }

    requeueGroup(id: number): number | null {
        return this.inWriteTransaction(() => {
            if (!this.getGroup(id)) {
                return null;
            }

            const result = this.db.prepare(
                `UPDATE reports
                 SET status = 'pending', group_id = NULL, error = NULL,
                     attempts = 0, next_attempt_at = 0
                 WHERE group_id = ?
                   AND status = 'processed'`,
            ).run(id);
            this.recountGroups([id]);

            return Number(result.changes);
        });
    }

    registerArtifact(
        repo: string,
        artifactId: number,
        releaseTag: string,
        artifactName: string,
    ): ArtifactIngestRow {
        this.db.prepare(
            `INSERT INTO artifact_ingests (
                 repo, artifact_id, release_tag, artifact_name
             )
             VALUES (?, ?, ?, ?)
             ON CONFLICT(repo, artifact_id) DO UPDATE
             SET release_tag = excluded.release_tag,
                 artifact_name = excluded.artifact_name`,
        ).run(repo, artifactId, releaseTag, artifactName);

        return this.getArtifactIngest(repo, artifactId)!;
    }

    getArtifactIngest(
        repo: string,
        artifactId: number,
    ): ArtifactIngestRow | null {
        return this.one<ArtifactIngestRow>(
            `SELECT *
             FROM artifact_ingests
             WHERE repo = ?
               AND artifact_id = ?`,
            repo,
            artifactId,
        );
    }

    listArtifactIngests(limit = 500): ArtifactIngestRow[] {
        return this.many<ArtifactIngestRow>(
            `SELECT *
             FROM artifact_ingests
             ORDER BY COALESCE(ingested_at, next_attempt_at) DESC,
                      artifact_id DESC
             LIMIT ?`,
            limit,
        );
    }

    markArtifactIngested(
        repo: string,
        artifactId: number,
        attempts: number,
        ingestedAt: number,
    ): void {
        this.db.prepare(
            `UPDATE artifact_ingests
             SET status = 'ingested', attempts = ?, next_attempt_at = 0,
                 error = NULL, ingested_at = ?
             WHERE repo = ?
               AND artifact_id = ?`,
        ).run(attempts, ingestedAt, repo, artifactId);
    }

    markArtifactError(
        repo: string,
        artifactId: number,
        error: string,
        attempts: number,
        nextAttemptAt: number,
        failed: boolean,
    ): void {
        this.db.prepare(
            `UPDATE artifact_ingests
             SET status = ?, attempts = ?, next_attempt_at = ?, error = ?
             WHERE repo = ?
               AND artifact_id = ?`,
        ).run(
            failed ? 'failed' : 'pending',
            attempts,
            nextAttemptAt,
            error,
            repo,
            artifactId,
        );
    }

    upsertGroup(signature: string, title: string, seenAt: number): number {
        const row = this.one<{ id: number }>(
            `INSERT INTO groups (
                 signature, title, first_seen, last_seen, report_count
             )
             VALUES (?, ?, ?, ?, 0)
             ON CONFLICT(signature) DO UPDATE
             SET last_seen = MAX(last_seen, excluded.last_seen)
             RETURNING id`,
            signature,
            title,
            seenAt,
            seenAt,
        );

        if (!row) {
            throw new Error('upsertGroup returned no row');
        }

        return Number(row.id);
    }

    recountGroups(ids: (number | null)[]): void {
        const recount = this.db.prepare(
            `UPDATE groups
             SET (report_count, first_seen, last_seen) = (
                 SELECT COUNT(*),
                        COALESCE(MIN(r.received_at), groups.first_seen),
                        COALESCE(MAX(r.received_at), groups.last_seen)
                 FROM reports r
                 WHERE r.group_id = groups.id
             )
             WHERE id = ?`,
        );
        const prune = this.db.prepare(
            `DELETE FROM groups
             WHERE id = ?
               AND report_count = 0`,
        );

        for (const id of new Set(ids)) {
            if (id === null) {
                continue;
            }

            recount.run(id);
            prune.run(id);
        }
    }

    getGroup(id: number): GroupRow | null {
        return this.one<GroupRow>(`SELECT * FROM groups WHERE id = ?`, id);
    }

    listGroups(filter: GroupFilter = {}): GroupListRow[] {
        const conds: string[] = [];
        const params: (string | number)[] = [];

        if (filter.product) {
            conds.push(
                `EXISTS (
                     SELECT 1
                     FROM reports r
                     WHERE r.group_id = g.id
                       AND r.product = ?
                 )`,
            );
            params.push(filter.product);
        }
        if (filter.version) {
            conds.push(
                `EXISTS (
                     SELECT 1
                     FROM reports r
                     WHERE r.group_id = g.id
                       AND r.version = ?
                 )`,
            );
            params.push(filter.version);
        }
        if (filter.platform) {
            conds.push(
                `EXISTS (
                     SELECT 1
                     FROM reports r
                     WHERE r.group_id = g.id
                       AND r.platform = ?
                 )`,
            );
            params.push(filter.platform);
        }
        if (filter.ptype) {
            conds.push(
                `EXISTS (
                     SELECT 1
                     FROM reports r
                     WHERE r.group_id = g.id
                       AND r.ptype = ?
                 )`,
            );
            params.push(filter.ptype);
        }

        const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
        const order = filter.sort === 'last_seen'
            ? 'g.last_seen DESC'
            : 'g.report_count DESC';

        const sql = `SELECT g.*,
                    (
                        SELECT GROUP_CONCAT(DISTINCT r.product)
                        FROM reports r
                        WHERE r.group_id = g.id
                    ) AS products,
                    (
                        SELECT GROUP_CONCAT(DISTINCT r.version)
                        FROM reports r
                        WHERE r.group_id = g.id
                    ) AS versions,
                    (
                        SELECT GROUP_CONCAT(DISTINCT r.platform)
                        FROM reports r
                        WHERE r.group_id = g.id
                          AND r.platform IS NOT NULL
                    ) AS platforms,
                    (
                        SELECT COUNT(*)
                        FROM reports r
                        WHERE r.group_id = g.id
                          AND r.symbolicated = 0
                    ) AS unsymbolicated
             FROM groups g
             ${where}
             ORDER BY ${order}
             LIMIT 500`;

        return this.many<GroupListRow>(sql, ...params);
    }

    reportsForGroup(groupId: number, limit = 50): ReportRow[] {
        return this.many<ReportRow>(
            `SELECT *
             FROM reports
             WHERE group_id = ?
             ORDER BY received_at DESC
             LIMIT ?`,
            groupId,
            limit,
        );
    }

    latestProcessedReport(groupId: number): ReportRow | null {
        return this.one<ReportRow>(
            `SELECT *
             FROM reports
             WHERE group_id = ?
               AND status = 'processed'
             ORDER BY received_at DESC
             LIMIT 1`,
            groupId,
        );
    }

    reportsPerDay(
        sinceMs: number,
        options: {
            breakdown?: ChartBreakdown;
            filter?: GroupFilter;
            groupId?: number;
        } = {},
    ): ReportDayStat[] {
        const { breakdown = 'total', filter = {}, groupId } = options;
        const column = breakdown === 'version' || breakdown === 'platform'
            ? breakdown
            : null;
        const conditions = ['received_at >= ?'];
        const params: (string | number)[] = [sinceMs];
        for (
            const key of ['product', 'version', 'platform', 'ptype'] as const
        ) {
            if (filter[key]) {
                conditions.push(`${key} = ?`);
                params.push(filter[key]);
            }
        }
        if (groupId !== undefined) {
            conditions.push('group_id = ?');
            params.push(groupId);
        }
        return this.many<ReportDayStat>(
            `SELECT
                 strftime(
                     '%Y-%m-%d',
                     received_at / 1000,
                     'unixepoch'
                 ) AS day,
                 COUNT(*) AS n,
                 ${column ?? 'NULL'} AS segment
             FROM reports
             WHERE ${conditions.join(' AND ')}
             GROUP BY day, segment
             ORDER BY day, segment`,
            ...params,
        );
    }

    filterOptions(): {
        products: string[];
        versions: string[];
        platforms: string[];
        ptypes: string[];
    } {
        const col = (sql: string): string[] =>
            this.many<{ v: string }>(sql).map((r) => r.v);
        return {
            products: col(
                `SELECT DISTINCT product AS v
                 FROM reports
                 WHERE product IS NOT NULL
                 ORDER BY v
                 LIMIT 100`,
            ),
            versions: col(
                `SELECT DISTINCT version AS v
                 FROM reports
                 WHERE version IS NOT NULL
                 ORDER BY v DESC
                 LIMIT 100`,
            ),
            platforms: col(
                `SELECT DISTINCT platform AS v
                 FROM reports
                 WHERE platform IS NOT NULL
                 ORDER BY v
                 LIMIT 20`,
            ),
            ptypes: col(
                `SELECT DISTINCT ptype AS v
                 FROM reports
                 WHERE ptype IS NOT NULL
                 ORDER BY v
                 LIMIT 20`,
            ),
        };
    }

    deleteExpiredReports(cutoffMs: number): string[] {
        return this.inWriteTransaction(() => {
            const expiredReports = this.many<{
                id: string;
                group_id: number | null;
            }>(
                `DELETE FROM reports
                 WHERE received_at < ?
                   AND status <> 'processing'
                 RETURNING id, group_id`,
                cutoffMs,
            );
            this.recountGroups(expiredReports.map((report) => report.group_id));
            return expiredReports.map((report) => report.id);
        });
    }

    deleteReport(id: string): void {
        this.inWriteTransaction(() => {
            const groupId = this.one<{ group_id: number | null }>(
                `DELETE FROM reports
                 WHERE id = ?
                 RETURNING group_id`,
                id,
            )?.group_id ?? null;
            this.recountGroups([groupId]);
        });
    }

    deleteGroup(id: number): string[] | null {
        return this.inWriteTransaction(() => {
            if (!this.getGroup(id)) {
                return null;
            }

            const reportIds = this.many<{ id: string }>(
                `DELETE FROM reports
                 WHERE group_id = ?
                 RETURNING id`,
                id,
            ).map((report) => report.id);
            this.recountGroups([id]);

            return reportIds;
        });
    }
}
