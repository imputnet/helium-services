import { assert, assertEquals } from '@std/assert';

import {
    looksLikeAppleCrashReport,
    normalizeAppleCrashReport,
    parseAppleCrashMeta,
} from '../src/applecrash.ts';

function fixture(): Promise<string> {
    return Deno.readTextFile(
        new URL('./fixtures/apple_report.txt', import.meta.url),
    );
}

Deno.test('recognizes translated reports and rejects .ips JSON', async () => {
    assert(looksLikeAppleCrashReport(await fixture()));
    assert(!looksLikeAppleCrashReport('{"app_name":"Helium"}'));
    assert(!looksLikeAppleCrashReport('random text'));
});

Deno.test('extracts report metadata', async () => {
    const meta = parseAppleCrashMeta(await fixture());
    assertEquals(meta.process, 'Helium');
    assertEquals(meta.identifier, 'net.imput.helium');
    assertEquals(meta.version, '0.14.3.1');
    assertEquals(meta.incidentId, '893ED25D-2D48-4068-9451-7BB173D52BDD');
    assertEquals(meta.osVersion, 'macOS 26.5.1 (25F80)');
    assertEquals(meta.hardwareModel, 'Mac16,10');
});

Deno.test('normalization produces the classic parser format', async () => {
    const normalized = normalizeAppleCrashReport(await fixture());

    // Banner and Full Report JSON are stripped.
    assert(!normalized.includes('Translated Report'));
    assert(!normalized.includes('Full Report'));
    assert(!normalized.includes('"app_name"'));

    // Four-digit fractional seconds are truncated to the three digits that
    // pre-2026-03 symbolicator parsers accept.
    assert(
        normalized.includes(
            'Date/Time:           2026-07-07 20:14:06.264 +0000',
        ),
    );
    assert(!normalized.includes('20:14:06.2645'));

    // Binary Images lines gain the arch column before <uuid>.
    assert(
        normalized.includes(
            'net.imput.helium.framework arm64 (0.14.3.1) <4c4c44fc-5555-3144-a1ef-327a92b9b0e8>',
        ),
        'framework image line should carry an arch column',
    );
    assert(
        normalized.includes(
            'libobjc-trampolines.dylib arm64 (*) <ca58aa96-b997-3a6d-9132-19d49be4b3e9>',
        ),
        'dylib image line should carry an arch column',
    );

    // Modern `Thread N:: name` headers become classic name+header pairs.
    assert(normalized.includes('Thread 0 name:  CrBrowserMain'));
    assert(/^Thread 0 Crashed:$/m.test(normalized));
    assert(normalized.includes('Thread 1 name:  StackSamplingProfiler'));
    assert(/^Thread 1:$/m.test(normalized));
    // Empty threads and register state lines pass through.
    assert(/^Thread 2:$/m.test(normalized));
    assert(normalized.includes('crashed with ARM Thread State'));
    // Frames are untouched.
    assert(normalized.includes('0x11a316988 ChromeMain + 93296464'));
});

Deno.test('classic-format input passes through unchanged', () => {
    const classic = [
        'Process:             Helium [9625]',
        'Code Type:           ARM-64 (Native)',
        '',
        'Thread 0 Crashed:',
        '0   Helium  0x1024a485c main + 196',
        '',
        'Binary Images:',
        '       0x1024a4000 -        0x1024a7fff Helium arm64 (0.14.3.1) <4c4c4480-5555-3144-a1c9-68200780c659> /Applications/Helium.app/Contents/MacOS/Helium',
        '',
    ].join('\n');
    assertEquals(normalizeAppleCrashReport(classic), classic);
});
