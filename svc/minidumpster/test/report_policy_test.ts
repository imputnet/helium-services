import { assertEquals } from '@std/assert';

import { crashDiscardReason } from '../src/report-policy.ts';
import type { SymbolicatorResponse } from '../src/signature.ts';

function response(...functions: string[]): SymbolicatorResponse {
    return {
        status: 'completed',
        stacktraces: [
            {
                is_requesting_thread: true,
                frames: functions.map((fn) => ({ function: fn })),
            },
        ],
    };
}

Deno.test('non-actionable Chromium crash helpers are discarded', () => {
    const cases = [
        [
            "content::`anonymous namespace'::IntentionallyCrashBrowserForUnusableGpuProcess()",
            'unusable GPU process',
        ],
        [
            "`anonymous namespace'::CrashIfCannotAllocateSmallBitmap(BITMAPINFOHEADER*, void*)",
            'Windows GDI resource exhaustion',
        ],
        [
            'partition_alloc::TerminateBecauseOutOfMemory(unsigned long long)',
            'out of memory',
        ],
        [
            'partition_alloc::internal::PartitionOutOfMemoryCommitFailure(unsigned long long)',
            'out of memory',
        ],
        [
            'blink::PartitionsOutOfMemoryUsing512M(unsigned long long)',
            'out of memory',
        ],
        [
            'v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*)',
            'out of memory',
        ],
    ] as const;

    for (const [fn, reason] of cases) {
        assertEquals(crashDiscardReason(response(fn)), reason);
    }

    const windowsOom = response('RaiseException');
    windowsOom.crash_reason = 'Out of Memory / 0x7ff9a2f31ada';
    assertEquals(crashDiscardReason(windowsOom), 'out of memory');
});

Deno.test('ordinary crashes are retained', () => {
    assertEquals(
        crashDiscardReason(
            response('content::RenderWidgetHostImpl::OnKeyboardEvent()'),
        ),
        null,
    );
    assertEquals(
        crashDiscardReason(response('gpu::HandleOutOfMemory()')),
        null,
    );
});
