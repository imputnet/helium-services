import { Hono, type MiddlewareHandler } from 'hono';
import { accepts } from 'hono/accepts';
import { serveStatic } from 'hono/deno';

import * as ui from '../ui.ts';
import { logError, logEvent } from '../log.ts';
import { requireSession } from './auth.ts';
import type { GroupFilter } from '../db.ts';
import type { AppDeps, Env } from '../app.ts';
import {
    deleteGroupAndPayloads,
    deleteReportAndPayload,
    insertReportForStoredDump,
    readProcessedResponse,
    reportExpiresAt,
} from '../reports.ts';
import {
    dumpPath,
    processedPath,
    symbolsDir,
    writeFileWithDirs,
} from '../paths.ts';
import {
    looksLikeAppleCrashReport,
    parseAppleCrashMeta,
} from '../applecrash.ts';
import { githubIssueUrl } from '../github.ts';

const disablePrivateResponseCaching: MiddlewareHandler<Env> = async (
    c,
    next,
) => {
    await next();
    c.header('cache-control', 'private, no-store');
};

async function readProcessed(dataDir: string, reportId: string) {
    try {
        return await readProcessedResponse(dataDir, reportId);
    } catch (err) {
        logError('failed_parsing_processed', err, { dataDir, reportId });
        return null;
    }
}

async function installedSymbolBundles(
    dataDir: string,
): Promise<{ id: string; updatedAt: number | null }[]> {
    const dir = `${symbolsDir(dataDir)}/bundles`;
    const bundles: { id: string; updatedAt: number | null }[] = [];
    try {
        for await (const entry of Deno.readDir(dir)) {
            if (!entry.isFile) {
                continue;
            }

            const stat = await Deno.stat(`${dir}/${entry.name}`);
            bundles.push({
                id: entry.name,
                updatedAt: stat.mtime?.getTime() ?? null,
            });
        }
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
            logError('symbols_overview_read_error', err, { dir });
        }
    }
    return bundles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function webRoutes(deps: AppDeps): Hono<Env> {
    const { config, db } = deps;
    const app = new Hono<Env>();

    app.use('/static/*', serveStatic({ root: './src' }));
    app.use('*', deps.webAuth ?? requireSession(config));
    app.use('*', disablePrivateResponseCaching);

    app.get('/', (c) => {
        const filter: GroupFilter = {
            product: c.req.query('product'),
            version: c.req.query('version'),
            platform: c.req.query('platform'),
            ptype: c.req.query('ptype'),
            sort: c.req.query('sort') === 'last_seen' ? 'last_seen' : 'count',
        };

        const groups = db.listGroups(filter);
        const value = c.req.query('breakdown');
        const breakdown = value === 'version' || value === 'platform'
            ? value
            : 'total';
        const stats = db.reportsPerDay(ui.reportChartSince(), {
            breakdown,
            filter,
        });
        const options = db.filterOptions();

        return c.html(
            ui.groupsPage(
                { groups, stats, options, filter, breakdown },
                c.get('session').login,
            ),
        );
    });

    app.get('/search', (c) => {
        const q = (c.req.query('q') ?? '').trim();
        const login = c.get('session').login;
        if (!q) {
            return c.html(
                ui.messagePage(
                    'Search',
                    'Enter a report id, guid, or function name.',
                    login,
                ),
                400,
            );
        }

        const reports = db.searchReports(q);
        const groups = db.searchGroups(q);
        if (reports.length === 1) {
            return c.redirect(`/reports/${reports[0].id}`);
        }
        if (groups.length === 1) {
            return c.redirect(`/groups/${groups[0].id}`);
        }

        return c.html(ui.searchPage(q, { groups, reports }, login));
    });

    app.get('/upload', (c) => c.html(ui.uploadPage(c.get('session').login)));

    app.get('/symbols', async (c) => {
        const artifacts = db.listArtifactIngests();
        const bundles = await installedSymbolBundles(config.dataDir);
        return c.html(
            ui.symbolsPage({ artifacts, bundles }, c.get('session').login),
        );
    });

    app.post('/upload', async (c) => {
        const login = c.get('session').login;
        let form: FormData;
        try {
            form = await c.req.raw.formData();
        } catch {
            return c.html(
                ui.uploadPage(login, 'Could not read the form.'),
                400,
            );
        }

        const file = form.get('file');
        const pasted = form.get('text');
        let text = '';
        if (file instanceof File && file.size > 0) {
            if (file.size > config.maxDumpSizeBytes) {
                return c.html(ui.uploadPage(login, 'File too large.'), 413);
            }
            text = await file.text();
        } else if (typeof pasted === 'string') {
            text = pasted;
        }
        text = text.trim();

        if (text === '') {
            return c.html(
                ui.uploadPage(login, 'Paste a crash report or attach a file.'),
                400,
            );
        }
        const encoded = new TextEncoder().encode(text);
        if (encoded.byteLength > config.maxDumpSizeBytes) {
            return c.html(ui.uploadPage(login, 'Report too large.'), 413);
        }
        if (!looksLikeAppleCrashReport(text)) {
            return c.html(
                ui.uploadPage(
                    login,
                    'That does not look like a macOS crash report. Paste the '
                        + '"Translated Report" text (raw .ips JSON is not supported).',
                ),
                400,
            );
        }

        const meta = parseAppleCrashMeta(text);
        const existing = meta.incidentId
            ? db.findReportByGuid(meta.incidentId)
            : null;
        if (existing) {
            if (existing.status === 'failed') {
                db.markRetry(existing.id, 'requeued by re-upload', 0, 0);
            }
            return c.redirect(`/reports/${existing.id}`);
        }

        const annotations: Record<string, string> = {
            source: 'manual-apple-crash-report',
            uploaded_by: login,
        };
        if (meta.identifier) annotations['bundle_id'] = meta.identifier;
        if (meta.osVersion) annotations['os_version'] = meta.osVersion;
        if (meta.hardwareModel) annotations['hw_model'] = meta.hardwareModel;

        const id = crypto.randomUUID();
        await writeFileWithDirs(dumpPath(config.dataDir, id), encoded);
        insertReportForStoredDump(db, config, {
            id,
            kind: 'apple',
            product: meta.process,
            version: meta.version,
            guid: meta.incidentId,
            ptype: null,
            channel: null,
            annotations: JSON.stringify(annotations),
            received_at: Date.now(),
        });

        logEvent('report_received', {
            report_id: id,
            kind: 'apple',
            uploaded_by: login,
            bytes: encoded.byteLength,
        });

        return c.redirect(`/reports/${id}`);
    });

    app.get('/groups/:id', async (c) => {
        const id = Number(c.req.param('id'));
        const group = Number.isInteger(id) ? db.getGroup(id) : null;
        if (!group) {
            return c.html(ui.messagePage('Not found', 'No such group.'), 404);
        }

        const reports = db.reportsForGroup(group.id);

        let latestStack: { reportId: string; html: string } | null = null;
        const latest = db.latestProcessedReport(group.id);
        if (latest) {
            const resp = await readProcessed(config.dataDir, latest.id);
            if (resp) {
                latestStack = {
                    reportId: latest.id,
                    html: ui.stackHtml(resp, false),
                };
            }
        }

        const value = c.req.query('breakdown');
        const breakdown = value === 'version' || value === 'platform'
            ? value
            : 'total';
        const stats = db.reportsPerDay(ui.reportChartSince(), {
            groupId: group.id,
            breakdown,
        });
        return c.html(
            ui.groupPage(
                { group, reports, latestStack, stats, breakdown },
                c.get('session').login,
            ),
        );
    });

    app.post('/groups/:id/delete', (c) => {
        const id = Number(c.req.param('id'));
        const reportIds = Number.isInteger(id)
            ? deleteGroupAndPayloads(db, config, id)
            : null;
        if (!reportIds) {
            return c.html(ui.messagePage('Not found', 'No such group.'), 404);
        }

        logEvent('group_deleted_manual', {
            group_id: id,
            reports_deleted: reportIds.length,
            deleted_by: c.get('session').login,
        });
        return c.redirect('/', 303);
    });

    app.post('/groups/:id/reprocess', (c) => {
        const id = Number(c.req.param('id'));
        const requeued = Number.isInteger(id) ? db.requeueGroup(id) : null;
        if (requeued === null) {
            return c.html(ui.messagePage('Not found', 'No such group.'), 404);
        }

        logEvent('group_requeued_manual', {
            group_id: id,
            reports_requeued: requeued,
            requeued_by: c.get('session').login,
        });
        return c.redirect('/', 303);
    });

    app.get('/reports/:id', async (c) => {
        const report = db.getReport(c.req.param('id'));
        if (!report) {
            return c.html(ui.messagePage('Not found', 'No such report.'), 404);
        }

        const group = report.group_id != null
            ? db.getGroup(report.group_id)
            : null;

        const responseType = accepts(c, {
            header: 'Accept',
            supports: ['text/html', 'text/plain'],
            default: 'text/html',
        });
        const wantsPlain = responseType === 'text/plain';
        let stack: string | null = null;
        let issueUrl: string | null = null;
        let hasProcessedResponse = false;
        if (report.status === 'processed') {
            const resp = await readProcessed(config.dataDir, report.id);
            if (resp) {
                hasProcessedResponse = true;
                if (wantsPlain) {
                    return c.text(
                        ui.reportCopyText(
                            report,
                            group,
                            resp,
                        ),
                        200,
                        { 'content-type': 'text/plain; charset=utf-8' },
                    );
                }
                stack = ui.stackHtml(resp, true);
                if (config.githubIssueRepo && config.githubIssueTemplate) {
                    issueUrl = githubIssueUrl(
                        config.githubIssueRepo,
                        config.githubIssueTemplate,
                        report,
                        group,
                        resp,
                    );
                }
            }
        }

        if (wantsPlain) {
            return c.text('not found\n', 404);
        }

        return c.html(
            ui.reportPage(
                report,
                group,
                stack,
                hasProcessedResponse,
                issueUrl,
                reportExpiresAt(
                    report.received_at,
                    config.retentionDays,
                ),
                c.get('session').login,
            ),
        );
    });

    app.post('/reports/:id/reprocess', (c) => {
        const id = c.req.param('id');
        const report = db.getReport(id);
        if (!report) {
            return c.html(ui.messagePage('Not found', 'No such report.'), 404);
        }
        if (!db.requeueReport(id)) {
            return c.html(
                ui.messagePage(
                    'Cannot reprocess',
                    'Only processed reports can be reprocessed.',
                    c.get('session').login,
                ),
                409,
            );
        }

        logEvent('report_requeued_manual', {
            report_id: id,
            requeued_by: c.get('session').login,
        });
        return c.redirect(`/reports/${id}`, 303);
    });

    app.post('/reports/:id/delete', (c) => {
        const id = c.req.param('id');
        const report = db.getReport(id);
        if (!report) {
            return c.html(ui.messagePage('Not found', 'No such report.'), 404);
        }

        deleteReportAndPayload(db, config, id);
        const groupId = report.group_id;
        const redirect = groupId != null && db.getGroup(groupId)
            ? `/groups/${groupId}`
            : '/';
        logEvent('report_deleted_manual', {
            report_id: id,
            group_id: groupId,
            deleted_by: c.get('session').login,
        });
        return c.redirect(redirect, 303);
    });

    app.get('/reports/:id/dump', async (c) => {
        const report = db.getReport(c.req.param('id'));
        if (!report) {
            return c.text('not found\n', 404);
        }

        try {
            const file = await Deno.open(dumpPath(config.dataDir, report.id), {
                read: true,
            });

            const apple = report.kind === 'apple';
            return c.body(file.readable, 200, {
                'content-type': apple
                    ? 'text/plain; charset=utf-8'
                    : 'application/octet-stream',
                'content-disposition': `attachment; filename="${report.id}.${
                    apple ? 'crash.txt' : 'dmp'
                }"`,
            });
        } catch {
            return c.text('not found\n', 404);
        }
    });

    app.get('/reports/:id/json', async (c) => {
        const report = db.getReport(c.req.param('id'));
        if (!report || report.status !== 'processed') {
            return c.text('not found\n', 404);
        }

        try {
            const file = await Deno.open(
                processedPath(config.dataDir, report.id),
                { read: true },
            );

            return c.body(file.readable, 200, {
                'content-type': 'application/json',
                'content-disposition':
                    `attachment; filename="${report.id}.json"`,
            });
        } catch {
            return c.text('not found\n', 404);
        }
    });

    return app;
}
