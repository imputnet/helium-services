import { assert, assertEquals, assertNotEquals } from '@std/assert';

import { fixtureResponse } from './helpers.ts';
import {
    computeSignature,
    fallbackSignature,
    platformFromResponse,
    type SymbolicatorResponse,
} from '../src/signature.ts';

async function fixture(): Promise<SymbolicatorResponse> {
    return JSON.parse(await fixtureResponse()) as SymbolicatorResponse;
}

Deno.test('signature prefers app frames when a module hint matches', async () => {
    const resp = await fixture();
    const sig = await computeSignature(resp, {
        topN: 5,
        appHints: ['MyBrowser'],
    });
    assert(sig);
    // Frame 0 is ntdll (not ours) — the title is the first app frame instead.
    assertEquals(sig.title, 'content::RenderProcessHostImpl::OnChannelError()');
});

Deno.test('signature falls back to all frames without matching hints', async () => {
    const resp = await fixture();
    const sig = await computeSignature(resp, {
        topN: 5,
        appHints: ['someOtherProduct'],
    });
    assert(sig);
    assertEquals(sig.title, 'RtlRaiseStatus');
});

Deno.test('signature is deterministic and sensitive to the stack', async () => {
    const resp = await fixture();
    const a = await computeSignature(resp, {
        topN: 5,
        appHints: ['mybrowser'],
    });
    const b = await computeSignature(resp, {
        topN: 5,
        appHints: ['mybrowser'],
    });
    assert(a && b);
    assertEquals(a.signature, b.signature);
    assertEquals(a.signature.length, 64);

    const mutated = await fixture();
    mutated.stacktraces![0].frames[1].function = 'something::Else()';
    const c = await computeSignature(mutated, {
        topN: 5,
        appHints: ['mybrowser'],
    });
    assert(c);
    assertNotEquals(a.signature, c.signature);

    // Frames beyond topN don't affect the signature.
    const deep = await fixture();
    deep.stacktraces![0].frames[5].function = 'renamed_bottom_frame';
    const d = await computeSignature(deep, {
        topN: 3,
        appHints: ['mybrowser'],
    });
    const e = await computeSignature(await fixture(), {
        topN: 3,
        appHints: ['mybrowser'],
    });
    assert(d && e);
    assertEquals(d.signature, e.signature);
});

Deno.test('signature uses the requesting thread', async () => {
    const resp = await fixture();
    // Swap thread order; is_requesting_thread should still win.
    resp.stacktraces = [resp.stacktraces![1], resp.stacktraces![0]];
    const sig = await computeSignature(resp, { topN: 5, appHints: [] });
    assert(sig);
    assertEquals(sig.title, 'RtlRaiseStatus');
});

Deno.test('frames without function names fall back to module+address', async () => {
    const resp = await fixture();
    const frame = resp.stacktraces![0].frames[0];
    frame.function = null;
    frame.symbol = null;
    const sig = await computeSignature(resp, { topN: 5 });
    assert(sig);
    assertEquals(sig.title, 'ntdll.dll+0x7ffb2c341234');
});

Deno.test('fallback signature covers responses without stacktraces', async () => {
    const resp = await fixture();
    resp.stacktraces = [];
    assertEquals(await computeSignature(resp), null);
    const fb = await fallbackSignature(resp);
    assertEquals(
        fb.title,
        'EXCEPTION_ACCESS_VIOLATION_WRITE / 0x0000000000000000',
    );
    assertEquals(fb.signature.length, 64);
});

Deno.test('platform is derived from system_info', async () => {
    assertEquals(platformFromResponse(await fixture()), 'Windows');
    assertEquals(platformFromResponse({ status: 'completed' }), null);
});

function sentinelStack(frames: [string, string][]): SymbolicatorResponse {
    return {
        status: 'completed',
        crash_reason: 'EXC_BREAKPOINT (SIGTRAP)',
        stacktraces: [{
            thread_id: 0,
            is_requesting_thread: true,
            frames: frames.map(([fn, pkg], i) => ({
                status: 'symbolicated',
                function: fn,
                package: pkg,
                instruction_addr: `0x${(0x1000 + i * 16).toString(16)}`,
            })),
        }],
    };
}

Deno.test('crash-machinery sentinel frames are skipped for the title', async () => {
    const helium = '/Applications/Helium.app/Helium Framework';
    const sig = await computeSignature(
        sentinelStack([
            ['ImmediateCrash', helium],
            ['CheckFailure', helium],
            ['VerticalTabStripRegionView::RequestCollapse(bool)', helium],
            ['views::View::OnBoundsChanged()', helium],
        ]),
        { topN: 5, appHints: ['helium'] },
    );
    assert(sig);
    assertEquals(
        sig.title,
        'VerticalTabStripRegionView::RequestCollapse(bool)',
    );
});

Deno.test('different machinery depth reaching the same frame groups together', async () => {
    const helium = '/Applications/Helium.app/Helium Framework';
    const viaCheck = await computeSignature(
        sentinelStack([
            ['ImmediateCrash', helium],
            ['CheckFailure', helium],
            ['content::HandleDebugURL(GURL const&)', helium],
        ]),
        { topN: 5 },
    );
    const viaNotreached = await computeSignature(
        sentinelStack([
            ['base::ImmediateCrash()', helium],
            ['logging::NotReachedError::TriggerNotReached()', helium],
            ['content::HandleDebugURL(GURL const&)', helium],
        ]),
        { topN: 5 },
    );
    assert(viaCheck && viaNotreached);
    assertEquals(viaCheck.signature, viaNotreached.signature);
    assertEquals(viaCheck.title, 'content::HandleDebugURL(GURL const&)');
});

Deno.test('an all-sentinel stack keeps its frames instead of vanishing', async () => {
    const helium = '/Applications/Helium.app/Helium Framework';
    const sig = await computeSignature(
        sentinelStack([
            ['ImmediateCrash', helium],
            ['CheckFailure', helium],
        ]),
        { topN: 5 },
    );
    assert(sig);
    assertEquals(sig.title, 'ImmediateCrash');
});

Deno.test('signature reports symbolication completeness', async () => {
    const full = await computeSignature(await fixture(), { topN: 5 });
    assert(full);
    assertEquals(full.symbolicated, true);

    const partial = await fixture();
    partial.stacktraces![0].frames[1].status = 'missing';
    const sig = await computeSignature(partial, { topN: 5 });
    assert(sig);
    assertEquals(sig.symbolicated, false);
});

Deno.test('unsymbolicated fallback labels are module-relative, not ASLR-absolute', async () => {
    const mk = (base: number): SymbolicatorResponse => ({
        status: 'completed',
        modules: [{
            debug_id: '4c4c4480-5555-3144-a1c9-68200780c659',
            code_file: '/app/Helium',
            image_addr: `0x${base.toString(16)}`,
            image_size: 0x100000,
        }],
        stacktraces: [{
            thread_id: 0,
            is_requesting_thread: true,
            frames: [{
                status: 'missing',
                package: '/app/Helium',
                instruction_addr: `0x${(base + 0x1234).toString(16)}`,
            }],
        }],
    });
    const a = await computeSignature(mk(0x100000000), { topN: 5 });
    const b = await computeSignature(mk(0x2f0000000), { topN: 5 });
    assert(a && b);
    assertEquals(a.title, 'Helium+0x1234');
    assertEquals(a.signature, b.signature);
    assertEquals(a.symbolicated, false);
});
