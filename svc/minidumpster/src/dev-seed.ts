import { type Config, devConfig } from './config.ts';
import { Db } from './db.ts';
import {
    dbPath,
    dumpPath,
    ensureDataDirs,
    processedPath,
    writeFileWithDirs,
} from './paths.ts';
import { indexReportResponse } from './report-search.ts';
import type { SymbolicatorResponse } from './signature.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const WINDOWS_RESPONSE = new URL(
    '../test/fixtures/symbolicator_completed.json',
    import.meta.url,
);
const APPLE_RESPONSE = new URL(
    '../test/fixtures/symbolicator_apple_completed.json',
    import.meta.url,
);
const APPLE_REPORT = new URL(
    '../test/fixtures/apple_report.txt',
    import.meta.url,
);

interface MockReport {
    id: string;
    group: 'keyboard' | 'renderer' | 'gpu' | 'machinery';
    product: string;
    version: string;
    platform: string;
    kind: 'minidump' | 'apple';
    ageMs: number;
    symbolicated: boolean;
}

const REPORTS: MockReport[] = [
    {
        id: '10000000-0000-4000-8000-000000000001',
        group: 'keyboard',
        product: 'Helium',
        version: '0.14.3.1',
        platform: 'macOS',
        kind: 'apple',
        ageMs: 2 * HOUR,
        symbolicated: true,
    },
    {
        id: '10000000-0000-4000-8000-000000000002',
        group: 'keyboard',
        product: 'Helium',
        version: '0.14.3.1',
        platform: 'macOS',
        kind: 'apple',
        ageMs: 9 * HOUR,
        symbolicated: true,
    },
    {
        id: '10000000-0000-4000-8000-000000000003',
        group: 'keyboard',
        product: 'Helium',
        version: '0.14.2.0',
        platform: 'macOS',
        kind: 'apple',
        ageMs: 2 * DAY,
        symbolicated: true,
    },
    {
        id: '20000000-0000-4000-8000-000000000001',
        group: 'renderer',
        product: 'Helium',
        version: '0.14.3.1',
        platform: 'Windows',
        kind: 'minidump',
        ageMs: DAY,
        symbolicated: true,
    },
    {
        id: '20000000-0000-4000-8000-000000000002',
        group: 'renderer',
        product: 'Helium',
        version: '0.14.1.0',
        platform: 'Windows',
        kind: 'minidump',
        ageMs: 4 * DAY,
        symbolicated: true,
    },
    {
        id: '30000000-0000-4000-8000-000000000001',
        group: 'gpu',
        product: 'Helium',
        version: '0.14.3.1',
        platform: 'Linux',
        kind: 'minidump',
        ageMs: 3 * HOUR,
        symbolicated: false,
    },
    {
        id: '50000000-0000-4000-8000-000000000001',
        group: 'machinery',
        product: 'Helium',
        version: '0.14.3.1',
        platform: 'Windows',
        kind: 'minidump',
        ageMs: 30 * 60 * 1000,
        symbolicated: true,
    },
];

const GROUPS = {
    keyboard: {
        signature: 'dev-keyboard-event',
        title: 'content::RenderWidgetHostImpl::OnKeyboardEvent()',
    },
    renderer: {
        signature: 'dev-renderer-channel',
        title: 'content::RenderProcessHostImpl::OnChannelError()',
    },
    gpu: {
        signature: 'dev-gpu-process',
        title: 'viz::GpuServiceImpl::InitializeWithHost()',
    },
    machinery: {
        signature: 'dev-crash-machinery-fold',
        title: 'v8::internal::maglev::MaglevPhiRepresentationSelector::PreProcessBasicBlock()',
    },
};

function minidump(): Uint8Array {
    const bytes = new Uint8Array(32);
    bytes.set([0x4d, 0x44, 0x4d, 0x50]);
    return bytes;
}

function responseFor(
    report: MockReport,
    windows: SymbolicatorResponse,
    apple: SymbolicatorResponse,
): SymbolicatorResponse {
    const source = report.kind === 'apple' ? apple : windows;
    const response = structuredClone(source);
    response.system_info = {
        ...response.system_info,
        os_name: report.platform,
    };

    if (report.group === 'gpu') {
        response.crash_reason = 'SIGSEGV / invalid GPU shared context';
        const frame = response.stacktraces?.[0]?.frames[0];
        if (frame) {
            frame.function = 'viz::GpuServiceImpl::InitializeWithHost()';
            frame.package = '/opt/helium/helium';
        }
    }
    if (report.group === 'machinery') {
        response.crash_reason = 'EXCEPTION_BREAKPOINT / mock fatal check';
        const module = 'C:\\Program Files\\Helium\\chrome.dll';
        response.stacktraces = [
            {
                thread_id: 42,
                thread_name: 'ThreadPoolForegroundWorker',
                is_requesting_thread: true,
                frames: [
                    'base::ImmediateCrash()',
                    'logging::LogMessage::HandleFatal()',
                    'logging::LogMessage::Flush::<lambda_0>::operator()()',
                    'absl::cleanup_internal::Storage<Callback>::InvokeCallback()',
                    'absl::Cleanup<Callback>::~Cleanup()',
                    'logging::LogMessage::Flush()',
                    'logging::LogMessageFatal::~LogMessageFatal()',
                    'v8::internal::maglev::MaglevPhiRepresentationSelector::PreProcessBasicBlock()',
                    'v8::internal::maglev::MaglevCompiler::Compile()',
                ].map((fn, index) => ({
                    status: 'symbolicated',
                    function: fn,
                    package: module,
                    instruction_addr: `0x${(0x1000 + index * 16).toString(16)}`,
                })),
            },
        ];
    }
    if (!report.symbolicated) {
        for (const trace of response.stacktraces ?? []) {
            for (const frame of trace.frames) {
                frame.status = 'missing';
                frame.filename = null;
                frame.lineno = null;
            }
        }
        for (const module of response.modules ?? []) {
            module.debug_status = 'missing';
        }
    }

    return response;
}

export async function seedDevData(
    db: Db,
    config: Pick<Config, 'dataDir'>,
    now = Date.now(),
) {
    const windows = JSON.parse(
        await Deno.readTextFile(WINDOWS_RESPONSE),
    ) as SymbolicatorResponse;
    const apple = JSON.parse(
        await Deno.readTextFile(APPLE_RESPONSE),
    ) as SymbolicatorResponse;
    const appleDump = await Deno.readTextFile(APPLE_REPORT);
    const groupIds = new Map<MockReport['group'], number>();
    let reportsCreated = 0;

    for (const report of REPORTS) {
        const receivedAt = now - report.ageMs;
        const group = GROUPS[report.group];
        const response = responseFor(report, windows, apple);
        const groupId = db.upsertGroup(
            group.signature,
            group.title,
            receivedAt,
        );
        groupIds.set(report.group, groupId);

        if (db.getReport(report.id)) {
            indexReportResponse(db, report.id, response);
            continue;
        }

        const annotations = {
            channel: report.version === '0.14.3.1' ? 'nightly' : 'stable',
            dev_fixture: 'true',
            guid: `DEV-${report.id.slice(0, 8)}`,
            source:
                report.kind === 'apple'
                    ? 'manual-apple-crash-report'
                    : 'crashpad',
        };
        db.insertReport({
            id: report.id,
            product: report.product,
            version: report.version,
            guid: `DEV-${report.id.slice(0, 8)}`,
            ptype:
                report.group === 'renderer' || report.group === 'machinery'
                    ? 'renderer'
                    : 'browser',
            channel: annotations.channel,
            annotations: JSON.stringify(annotations),
            received_at: receivedAt,
            kind: report.kind,
        });
        await writeFileWithDirs(
            dumpPath(config.dataDir, report.id),
            report.kind === 'apple' ? appleDump : minidump(),
        );
        await writeFileWithDirs(
            processedPath(config.dataDir, report.id),
            JSON.stringify(response, null, 2),
        );
        indexReportResponse(db, report.id, response);
        db.markProcessed(
            report.id,
            groupId,
            report.platform,
            receivedAt + 12_000,
            report.symbolicated,
            1,
        );
        reportsCreated++;
    }

    const pendingId = '40000000-0000-4000-8000-000000000001';
    if (!db.getReport(pendingId)) {
        db.insertReport({
            id: pendingId,
            product: 'Helium',
            version: '0.14.4-dev',
            guid: 'DEV-PENDING-0001',
            ptype: 'browser',
            channel: 'canary',
            annotations: JSON.stringify({
                dev_fixture: 'true',
                note: 'Intentionally pending; the mock server does not run a worker.',
            }),
            received_at: now - 20 * 60 * 1000,
        });
        await writeFileWithDirs(
            dumpPath(config.dataDir, pendingId),
            minidump(),
        );
        reportsCreated++;
    }

    db.recountGroups([...groupIds.values()]);

    const ingested = db.registerArtifact(
        'imputnet/helium-macos',
        900001,
        '0.14.3.1',
        'helium-macos-arm64-symbols',
    );
    db.markArtifactIngested(ingested.repo, ingested.artifact_id, 1, now - HOUR);
    const retrying = db.registerArtifact(
        'imputnet/helium-windows',
        900002,
        '0.14.4-dev',
        'helium-windows-x86_64-symbols',
    );
    db.markArtifactError(
        retrying.repo,
        retrying.artifact_id,
        'mock artifact download timed out',
        2,
        now + HOUR,
        false,
    );
    return { reportsCreated, reportsTotal: REPORTS.length + 1 };
}

if (import.meta.main) {
    const config = devConfig(Deno.env.toObject());
    await ensureDataDirs(config.dataDir);
    const db = new Db(dbPath(config.dataDir));
    try {
        const result = await seedDevData(db, config);
        console.log(
            `seeded ${result.reportsCreated} new mock reports `
                + `(${result.reportsTotal} total) in ${config.dataDir}`,
        );
    } finally {
        db.close();
    }
}
