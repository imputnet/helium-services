import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { Bucket, UmaLog } from './uma.ts';
import { hashFromDb, hashToDb } from './names.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayOf(ts: number): number {
    return Math.floor(ts / DAY_MS);
}

export function dayToIso(day: number): string {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

// Only aggregates are stored. Every log is folded into per-day counters keyed
// by (version, channel, os, arch), so no row can be traced back to a client.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  UNIQUE (version, channel, os, arch)
);
CREATE TABLE IF NOT EXISTS log_counts (
  day INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  logs INTEGER NOT NULL,
  PRIMARY KEY (day, segment_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS histogram_totals (
  hash INTEGER NOT NULL,
  day INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  logs INTEGER NOT NULL,
  samples INTEGER NOT NULL,
  sum INTEGER NOT NULL,
  PRIMARY KEY (hash, day, segment_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_totals_day ON histogram_totals(day);
CREATE TABLE IF NOT EXISTS histogram_buckets (
  hash INTEGER NOT NULL,
  day INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  min INTEGER NOT NULL,
  max INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (hash, day, segment_id, min, max)
) WITHOUT ROWID;
-- WITHOUT ROWID so the 64-bit hash isn't the rowid, which node:sqlite would
-- try to return as a JavaScript number.
CREATE TABLE IF NOT EXISTS histogram_names (
  hash INTEGER PRIMARY KEY,
  name TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_names_name ON histogram_names(name);
-- Histograms the team keeps an eye on, shown on the overview.
CREATE TABLE IF NOT EXISTS pinned (
  hash INTEGER PRIMARY KEY,
  pinned_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS seen_logs (
  sha1 TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_seen_logs_time ON seen_logs(received_at);

-- Daily active users, counted without a lasting identifier: each day has a random
-- salt, clients are only seen as HMAC(salt, client_id), and once the day is
-- over its counts are written to daily_users and both the salt and the hashes
-- are deleted. Nothing links a client across days or back to its client_id.
CREATE TABLE IF NOT EXISTS day_salts (
  day INTEGER PRIMARY KEY,
  salt BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS active_clients (
  day INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  client_hash BLOB NOT NULL,
  PRIMARY KEY (day, segment_id, client_hash)
) WITHOUT ROWID;
-- segment_id 0 holds the exact total across all segments for that day.
CREATE TABLE IF NOT EXISTS daily_users (
  day INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  users INTEGER NOT NULL,
  PRIMARY KEY (day, segment_id)
) WITHOUT ROWID;
`;

const ALL_SEGMENTS = 0;

export interface Filter {
    fromDay: number;
    version?: string;
    channel?: string;
    os?: string;
    arch?: string;
}

export interface HistogramListRow {
    hash: bigint;
    name: string | null;
    logs: number;
    samples: number;
    sum: number;
}

export interface BucketRow extends Bucket {
    version: string;
}

export interface DailyRow {
    day: number;
    logs: number;
    samples: number;
    sum: number;
}

export interface SegmentOptions {
    version: string[];
    channel: string[];
    os: string[];
    arch: string[];
}

type SqlParam = string | number | bigint | null;

interface SqlFragment {
    sql: string;
    params: SqlParam[];
}

function segmentClause(filter: Filter, column: string): SqlFragment {
    const conds: string[] = [];
    const params: SqlParam[] = [];

    for (const key of ['version', 'channel', 'os', 'arch'] as const) {
        const value = filter[key];

        if (value) {
            conds.push(`${key} = ?`);
            params.push(value);
        }
    }

    if (conds.length === 0) {
        return { sql: '', params };
    }

    return {
        sql: ` AND ${column} IN (SELECT id FROM segments WHERE ${
            conds.join(' AND ')
        })`,
        params,
    };
}

function likePattern(q: string): string {
    return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface VersionUsage {
    version: string;
    channel: string;
    logs: number;
}

export interface VersionBucketRow extends Bucket {
    hash: bigint;
    version: string;
}

export type RecordResult = 'stored' | 'duplicate';

export class Db {
    readonly #db: DatabaseSync;
    readonly #stmts = new Map<string, StatementSync>();

    constructor(path: string) {
        this.#db = new DatabaseSync(path);
        this.#db.exec('PRAGMA journal_mode = WAL');
        this.#db.exec('PRAGMA synchronous = NORMAL');
        this.#db.exec('PRAGMA busy_timeout = 5000');
        this.#db.exec(SCHEMA);
    }

    close(): void {
        this.#db.close();
    }

    #stmt(sql: string, bigints = false): StatementSync {
        const key = `${bigints}:${sql}`;
        let stmt = this.#stmts.get(key);

        if (!stmt) {
            stmt = this.#db.prepare(sql);
            stmt.setReadBigInts(bigints);
            this.#stmts.set(key, stmt);
        }

        return stmt;
    }

    /** Copies rows, which node:sqlite returns with a null prototype. */
    #all<Row>(sql: string, params: SqlParam[] = [], bigints = false): Row[] {
        return this.#stmt(sql, bigints).all(...params).map((r) =>
            // SAFETY: Row lists exactly the columns the SQL selects, and
            // node:sqlite reads INTEGER as number (bigint when bigints is
            // set), TEXT as string and BLOB as Uint8Array.
            ({ ...r }) as Row
        );
    }

    #get<Row>(sql: string, params: SqlParam[] = []): Row | undefined {
        return this.#all<Row>(sql, params)[0];
    }

    #transaction<T>(fn: () => T): T {
        this.#db.exec('BEGIN IMMEDIATE');

        try {
            const out = fn();
            this.#db.exec('COMMIT');

            return out;
        } catch (err) {
            this.#db.exec('ROLLBACK');
            throw err;
        }
    }

    #segmentId(log: UmaLog): number {
        this.#stmt(
            `INSERT INTO segments (version, channel, os, arch) VALUES (?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
        ).run(log.version, log.channel, log.os, log.arch);

        const row = this.#get<{ id: number }>(
            `SELECT id FROM segments
             WHERE version = ? AND channel = ? AND os = ? AND arch = ?`,
            [log.version, log.channel, log.os, log.arch],
        );

        return row!.id;
    }

    /** Deduplicated by SHA-1 of the uncompressed log, since clients retry
     * uploads whose response got lost. */
    recordLog(
        sha1: string,
        log: UmaLog,
        receivedAt: number,
        opts: {
            /** HMAC(salt for the day of receivedAt, client_id), or null. */
            clientHash?: Uint8Array | null;
            allow?: (hash: bigint) => boolean;
        } = {},
    ): RecordResult {
        const allow = opts.allow ?? (() => true);
        const day = dayOf(receivedAt);

        return this.#transaction(() => {
            const seen = this.#stmt(
                `INSERT INTO seen_logs (sha1, received_at) VALUES (?, ?)
                 ON CONFLICT DO NOTHING`,
            ).run(sha1, receivedAt);

            if (seen.changes === 0) {
                return 'duplicate';
            }

            const segment = this.#segmentId(log);
            this.#stmt(
                `INSERT INTO log_counts (day, segment_id, logs) VALUES (?, ?, 1)
                 ON CONFLICT DO UPDATE SET logs = logs + 1`,
            ).run(day, segment);

            if (opts.clientHash) {
                this.#stmt(
                    `INSERT INTO active_clients (day, segment_id, client_hash)
                     VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
                ).run(day, segment, opts.clientHash);
            }

            const total = this.#stmt(
                `INSERT INTO histogram_totals
                   (hash, day, segment_id, logs, samples, sum)
                 VALUES (?, ?, ?, 1, ?, ?)
                 ON CONFLICT DO UPDATE SET
                   logs = logs + 1,
                   samples = samples + excluded.samples,
                   sum = sum + excluded.sum`,
            );

            const bucket = this.#stmt(
                `INSERT INTO histogram_buckets
                   (hash, day, segment_id, min, max, count)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT DO UPDATE SET count = count + excluded.count`,
            );

            for (const h of log.histograms) {
                if (!allow(h.hash)) {
                    continue;
                }

                const hash = hashToDb(h.hash);
                let samples = 0;

                for (const b of h.buckets) {
                    if (b.count === 0) {
                        continue;
                    }

                    samples += b.count;
                    bucket.run(hash, day, segment, b.min, b.max, b.count);
                }

                total.run(hash, day, segment, samples, h.sum);
            }

            return 'stored';
        });
    }

    saltFor(day: number): Uint8Array {
        this.#stmt(
            'INSERT INTO day_salts (day, salt) VALUES (?, ?) ON CONFLICT DO NOTHING',
        ).run(day, crypto.getRandomValues(new Uint8Array(32)));

        const row = this.#get<{ salt: Uint8Array }>(
            'SELECT salt FROM day_salts WHERE day = ?',
            [day],
        );

        return row!.salt;
    }

    /** Turns the client hashes of every day before `beforeDay` into counts,
     * then forgets the hashes and the salts. */
    finalizeDaysBefore(beforeDay: number): number {
        return this.#transaction(() => {
            this.#stmt(
                `INSERT INTO daily_users (day, segment_id, users)
                 SELECT day, segment_id, COUNT(*) FROM active_clients
                 WHERE day < ? GROUP BY day, segment_id
                 ON CONFLICT DO UPDATE SET users = excluded.users`,
            ).run(beforeDay);
            this.#stmt(
                `INSERT INTO daily_users (day, segment_id, users)
                 SELECT day, ${ALL_SEGMENTS}, COUNT(DISTINCT client_hash)
                 FROM active_clients WHERE day < ? GROUP BY day
                 ON CONFLICT DO UPDATE SET users = excluded.users`,
            ).run(beforeDay);

            const hashes = this.#stmt(
                'DELETE FROM active_clients WHERE day < ?',
            ).run(beforeDay).changes;

            this.#stmt('DELETE FROM day_salts WHERE day < ?').run(beforeDay);

            return Number(hashes);
        });
    }

    /** Distinct users per day. Finalized days come from daily_users; days in
     * progress are counted from the live hashes. Filtered totals for
     * finalized days add up segments, so a client that changed segment that
     * day (say, by updating) is counted once per segment. */
    dailyUsers(filter: Filter): Map<number, number> {
        const seg = segmentClause(filter, 'segment_id');
        const out = new Map<number, number>();

        type Row = { day: number; users: number };

        const finalized = seg.sql
            ? this.#all<Row>(
                `SELECT day, SUM(users) AS users FROM daily_users
                 WHERE day >= ? AND segment_id != ${ALL_SEGMENTS}${seg.sql}
                 GROUP BY day`,
                [filter.fromDay, ...seg.params],
            )
            : this.#all<Row>(
                `SELECT day, users FROM daily_users
                 WHERE day >= ? AND segment_id = ${ALL_SEGMENTS}`,
                [filter.fromDay],
            );

        for (const r of finalized) {
            out.set(r.day, r.users);
        }

        const live = this.#all<Row>(
            `SELECT day, COUNT(DISTINCT client_hash) AS users
             FROM active_clients WHERE day >= ?${seg.sql} GROUP BY day`,
            [filter.fromDay, ...seg.params],
        );

        for (const r of live) {
            out.set(r.day, r.users);
        }

        return out;
    }

    upsertNames(entries: { hash: bigint; name: string }[]): number {
        const stmt = this.#stmt(
            `INSERT INTO histogram_names (hash, name) VALUES (?, ?)
             ON CONFLICT DO UPDATE SET name = excluded.name`,
        );

        return this.#transaction(() => {
            for (const e of entries) {
                stmt.run(hashToDb(e.hash), e.name);
            }

            return entries.length;
        });
    }

    nameCount(): number {
        return this.#get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM histogram_names',
        )!.n;
    }

    nameFor(hash: bigint): string | null {
        return this.#get<{ name: string }>(
            'SELECT name FROM histogram_names WHERE hash = ?',
            [hashToDb(hash)],
        )?.name ?? null;
    }

    deleteBeforeDay(day: number): number {
        return this.#transaction(() => {
            let n = 0;

            for (
                const table of [
                    'histogram_buckets',
                    'histogram_totals',
                    'log_counts',
                    'daily_users',
                ]
            ) {
                n += Number(
                    this.#db.prepare(`DELETE FROM ${table} WHERE day < ?`)
                        .run(day).changes,
                );
            }

            this.#db.prepare(
                `DELETE FROM segments WHERE id NOT IN
                   (SELECT segment_id FROM log_counts)
                 AND id NOT IN (SELECT segment_id FROM active_clients)`,
            ).run();

            return n;
        });
    }

    deleteSeenBefore(ts: number): number {
        return Number(
            this.#stmt('DELETE FROM seen_logs WHERE received_at < ?').run(ts)
                .changes,
        );
    }

    segmentOptions(fromDay: number): SegmentOptions {
        const rows = this.#all<Record<keyof SegmentOptions, string>>(
            `SELECT DISTINCT s.version, s.channel, s.os, s.arch
             FROM segments s JOIN log_counts l ON l.segment_id = s.id
             WHERE l.day >= ?`,
            [fromDay],
        );

        const values = (key: keyof SegmentOptions) =>
            [...new Set(rows.map((r) => r[key]))].toSorted();

        return {
            version: values('version').toSorted((a, b) =>
                b.localeCompare(a, undefined, { numeric: true })
            ),
            channel: values('channel'),
            os: values('os'),
            arch: values('arch'),
        };
    }

    logCount(filter: Filter): number {
        const seg = segmentClause(filter, 'segment_id');

        return this.#get<{ n: number }>(
            `SELECT COALESCE(SUM(logs), 0) AS n FROM log_counts
             WHERE day >= ?${seg.sql}`,
            [filter.fromDay, ...seg.params],
        )!.n;
    }

    listHistograms(
        filter: Filter,
        query: { text?: string; hash?: bigint } = {},
        limit = 500,
    ): HistogramListRow[] {
        const seg = segmentClause(filter, 't.segment_id');
        let match = '';
        const params: SqlParam[] = [filter.fromDay, ...seg.params];

        if (query.hash !== undefined) {
            match = ' AND t.hash = ?';
            params.push(hashToDb(query.hash));
        } else if (query.text) {
            match = ` AND n.name LIKE ? ESCAPE '\\'`;
            params.push(likePattern(query.text));
        }

        params.push(limit);

        const rows = this.#all<{
            hash: bigint;
            name: string | null;
            logs: bigint;
            samples: bigint;
            sum: bigint;
        }>(
            `SELECT t.hash, n.name, SUM(t.logs) AS logs,
                    SUM(t.samples) AS samples, SUM(t.sum) AS sum
             FROM histogram_totals t
             LEFT JOIN histogram_names n ON n.hash = t.hash
             WHERE t.day >= ?${seg.sql}${match}
             GROUP BY t.hash
             ORDER BY logs DESC, samples DESC
             LIMIT ?`,
            params,
            true,
        );

        return rows.map((r) => ({
            hash: hashFromDb(r.hash),
            name: r.name,
            logs: Number(r.logs),
            samples: Number(r.samples),
            sum: Number(r.sum),
        }));
    }

    buckets(hash: bigint, filter: Filter): Bucket[] {
        const seg = segmentClause(filter, 'segment_id');

        return this.#all<Bucket>(
            `SELECT min, max, SUM(count) AS count FROM histogram_buckets
             WHERE hash = ? AND day >= ?${seg.sql}
             GROUP BY min, max ORDER BY min, max`,
            [hashToDb(hash), filter.fromDay, ...seg.params],
        );
    }

    bucketsByVersion(hash: bigint, filter: Filter): BucketRow[] {
        const seg = segmentClause(filter, 'b.segment_id');

        return this.#all<BucketRow>(
            `SELECT s.version, b.min, b.max, SUM(b.count) AS count
             FROM histogram_buckets b JOIN segments s ON s.id = b.segment_id
             WHERE b.hash = ? AND b.day >= ?${seg.sql}
             GROUP BY s.version, b.min, b.max ORDER BY b.min, b.max`,
            [hashToDb(hash), filter.fromDay, ...seg.params],
        );
    }

    daily(hash: bigint, filter: Filter): DailyRow[] {
        const seg = segmentClause(filter, 'segment_id');

        return this.#all<DailyRow>(
            `SELECT day, SUM(logs) AS logs, SUM(samples) AS samples,
                    SUM(sum) AS sum
             FROM histogram_totals
             WHERE hash = ? AND day >= ?${seg.sql}
             GROUP BY day ORDER BY day`,
            [hashToDb(hash), filter.fromDay, ...seg.params],
        );
    }

    dailyLogCounts(filter: Filter): Map<number, number> {
        const seg = segmentClause(filter, 'segment_id');

        const rows = this.#all<{ day: number; logs: number }>(
            `SELECT day, SUM(logs) AS logs FROM log_counts
             WHERE day >= ?${seg.sql} GROUP BY day`,
            [filter.fromDay, ...seg.params],
        );

        return new Map(rows.map((r) => [r.day, r.logs]));
    }

    pin(hash: bigint, now: number = Date.now()): void {
        this.#stmt(
            `INSERT INTO pinned (hash, pinned_at) VALUES (?, ?)
             ON CONFLICT DO NOTHING`,
        ).run(hashToDb(hash), now);
    }

    unpin(hash: bigint): void {
        this.#stmt('DELETE FROM pinned WHERE hash = ?').run(hashToDb(hash));
    }

    isPinned(hash: bigint): boolean {
        return this.#get('SELECT 1 FROM pinned WHERE hash = ?', [
            hashToDb(hash),
        ]) !== undefined;
    }

    pinned(): { hash: bigint; name: string | null }[] {
        const rows = this.#all<{ hash: bigint; name: string | null }>(
            `SELECT p.hash, n.name FROM pinned p
             LEFT JOIN histogram_names n ON n.hash = p.hash
             ORDER BY p.pinned_at`,
            [],
            true,
        );

        return rows.map((r) => ({ hash: hashFromDb(r.hash), name: r.name }));
    }

    /** Ignores the version filter. */
    versionUsage(filter: Filter): VersionUsage[] {
        const seg = segmentClause(
            { ...filter, version: undefined },
            'l.segment_id',
        );

        return this.#all<VersionUsage>(
            `SELECT s.version, s.channel, SUM(l.logs) AS logs
             FROM log_counts l JOIN segments s ON s.id = l.segment_id
             WHERE l.day >= ?${seg.sql}
             GROUP BY s.version, s.channel`,
            [filter.fromDay, ...seg.params],
        );
    }

    mix(
        filter: Filter,
        dimension: 'os' | 'arch',
    ): Map<string, number> {
        const seg = segmentClause(filter, 'l.segment_id');

        const rows = this.#all<{ value: string; logs: number }>(
            `SELECT s.${dimension} AS value, SUM(l.logs) AS logs
             FROM log_counts l JOIN segments s ON s.id = l.segment_id
             WHERE l.day >= ?${seg.sql}
             GROUP BY s.${dimension}`,
            [filter.fromDay, ...seg.params],
        );

        return new Map(rows.map((r) => [r.value, r.logs]));
    }

    /** Number of logs containing each histogram, per version, for two
     * versions. Samples within a log are correlated, so this is the
     * effective sample size when comparing them. */
    logsForVersions(
        filter: Filter,
        versions: [string, string],
        hashes?: bigint[],
    ): Map<bigint, [number, number]> {
        const seg = segmentClause(
            { ...filter, version: undefined },
            't.segment_id',
        );

        const only = hashes
            ? ` AND t.hash IN (${hashes.map(() => '?').join(', ')})`
            : '';

        const rows = this.#all<{ hash: bigint; version: string; logs: bigint }>(
            `SELECT t.hash, s.version, SUM(t.logs) AS logs
             FROM histogram_totals t JOIN segments s ON s.id = t.segment_id
             WHERE t.day >= ? AND s.version IN (?, ?)${seg.sql}${only}
             GROUP BY t.hash, s.version`,
            [
                filter.fromDay,
                ...versions,
                ...seg.params,
                ...(hashes ?? []).map(hashToDb),
            ],
            true,
        );

        const out = new Map<bigint, [number, number]>();

        for (const r of rows) {
            const hash = hashFromDb(r.hash);
            const entry = out.get(hash) ?? [0, 0];
            entry[r.version === versions[0] ? 0 : 1] = Number(r.logs);
            out.set(hash, entry);
        }

        return out;
    }

    bucketsForVersions(
        filter: Filter,
        versions: [string, string],
        hashes?: bigint[],
    ): VersionBucketRow[] {
        const seg = segmentClause(
            { ...filter, version: undefined },
            'b.segment_id',
        );

        const only = hashes
            ? ` AND b.hash IN (${hashes.map(() => '?').join(', ')})`
            : '';

        const rows = this.#all<{
            hash: bigint;
            version: string;
            min: bigint;
            max: bigint;
            count: bigint;
        }>(
            `SELECT b.hash, s.version, b.min, b.max, SUM(b.count) AS count
             FROM histogram_buckets b JOIN segments s ON s.id = b.segment_id
             WHERE b.day >= ? AND s.version IN (?, ?)${seg.sql}${only}
             GROUP BY b.hash, s.version, b.min, b.max
             ORDER BY b.hash, b.min, b.max`,
            [
                filter.fromDay,
                ...versions,
                ...seg.params,
                ...(hashes ?? []).map(hashToDb),
            ],
            true,
        );

        return rows.map((r) => ({
            hash: hashFromDb(r.hash),
            version: r.version,
            min: Number(r.min),
            max: Number(r.max),
            count: Number(r.count),
        }));
    }
}
