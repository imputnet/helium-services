import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GroupRow, ReportRow } from '../src/db.ts';
import { githubIssueUrl } from '../src/github.ts';
import type { SymbolicatorResponse } from '../src/signature.ts';

const report: ReportRow = {
    id: 'report-id',
    group_id: 1,
    product: 'Helium',
    version: '1.2.3',
    platform: 'Windows 11 x86_64',
    guid: 'private-guid',
    ptype: 'browser',
    channel: null,
    annotations: '{"secret":"do not export"}',
    status: 'processed',
    error: null,
    attempts: 1,
    next_attempt_at: 0,
    received_at: 0,
    processed_at: 1,
    kind: 'minidump',
    symbolicated: 1,
};

const group: GroupRow = {
    id: 1,
    signature: 'signature',
    title: 'content::RenderWidgetHostImpl::Crash()',
    first_seen: 0,
    last_seen: 0,
    report_count: 1,
};

test('GitHub issue URL prefills the Helium bug report safely', () => {
    const response: SymbolicatorResponse = {
        status: 'completed',
        crash_reason: 'EXCEPTION_ACCESS_VIOLATION',
        system_info: { os_name: 'Windows', cpu_arch: 'x86_64' },
        stacktraces: [
            {
                thread_id: 7,
                is_requesting_thread: true,
                frames: [
                    {
                        function: 'content::RenderWidgetHostImpl::Crash()',
                        package: String.raw`C:\Users\secret\helium.dll`,
                        filename: String.raw`C:\Users\secret\src\content\host.cc`,
                        lineno: 42,
                        instruction_addr: '0x12345678',
                    },
                ],
            },
        ],
    };

    const url = new URL(
        githubIssueUrl(
            'imputnet/helium',
            'bug-report.yml',
            report,
            group,
            response,
        ),
    );

    assert.deepStrictEqual(
        url.origin + url.pathname,
        'https://github.com/imputnet/helium/issues/new',
    );
    assert.equal(url.searchParams.get('template'), 'bug-report.yml');
    assert.equal(url.searchParams.get('os'), 'Windows');
    assert.equal(url.searchParams.get('version'), '1.2.3');
    assert.deepStrictEqual(
        url.searchParams.get('description'),
        'content::RenderWidgetHostImpl::Crash()',
    );

    const additional = url.searchParams.get('additional')!;
    assert.deepStrictEqual(
        additional.includes(
            'content::RenderWidgetHostImpl::Crash() (content/host.cc:42, helium.dll)',
        ),
        true,
    );
    assert.ok(!additional.includes('secret'));
    assert.ok(!additional.includes('private-guid'));
    assert.ok(!additional.includes('0x12345678'));
    assert.ok(!additional.includes('do not export'));
});
