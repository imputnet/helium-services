import { createHash } from 'node:crypto';
import { basename } from 'node:path/win32';

export interface SymFrame {
    status?: string;
    function?: string | null;
    symbol?: string | null;
    package?: string | null;
    instruction_addr?: string;
    sym_addr?: string | null;
    filename?: string | null;
    abs_path?: string | null;
    lineno?: number | null;
}

export interface SymStacktrace {
    thread_id?: number | string;
    thread_name?: string | null;
    is_requesting_thread?: boolean;
    is_requesting?: boolean;
    registers?: Record<string, string>;
    frames: SymFrame[];
}

interface SymModule {
    debug_id?: string;
    code_file?: string | null;
    debug_file?: string | null;
    debug_status?: string;
    image_addr?: string;
    image_size?: number;
}

export interface SymbolicatorResponse {
    status: string;
    request_id?: string;
    retry_after?: number;
    message?: string;
    arch?: string;
    crashed?: boolean;
    crash_reason?: string | null;
    crash_details?: string | null;
    system_info?: { os_name?: string; os_version?: string; cpu_arch?: string };
    stacktraces?: SymStacktrace[];
    modules?: SymModule[];
}

interface SignatureResult {
    signature: string;
    title: string;
    symbolicated: boolean;
}

function parseHex(s: string | undefined | null): number | null {
    if (!s) {
        return null;
    }

    const n = Number.parseInt(s, 16);

    return Number.isFinite(n) ? n : null;
}

function moduleFor(
    f: SymFrame,
    modules: SymModule[] | undefined,
): SymModule | null {
    if (!modules || modules.length === 0) {
        return null;
    }

    if (f.package) {
        const byFile = modules.find((m) => m.code_file === f.package);
        if (byFile?.image_addr) {
            return byFile;
        }
    }

    const addr = parseHex(f.instruction_addr);
    if (addr === null) {
        return null;
    }

    return (
        modules.find((m) => {
            const base = parseHex(m.image_addr);
            return (
                base !== null
                && typeof m.image_size === 'number'
                && addr >= base
                && addr < base + m.image_size
            );
        }) ?? null
    );
}

function frameFunction(f: SymFrame): string | null {
    return (f.function ?? f.symbol)?.trim() || null;
}

function frameLabel(f: SymFrame, modules?: SymModule[]): string {
    const fn = frameFunction(f);
    if (fn !== null) return fn.replace(/\s+/g, ' ');

    const mod = f.package ? basename(f.package) : 'unknown';
    const m = moduleFor(f, modules);
    const addr = parseHex(f.instruction_addr);
    const base = m ? parseHex(m.image_addr) : null;

    if (addr !== null && base !== null) {
        return `${mod}+0x${(addr - base).toString(16)}`;
    }

    return `${mod}+${f.instruction_addr ?? '?'}`;
}

export function crashingThread(
    resp: SymbolicatorResponse,
): SymStacktrace | null {
    const traces = resp.stacktraces ?? [];
    if (traces.length === 0) {
        return null;
    }

    return (
        traces.find(
            (t) => t.is_requesting_thread === true || t.is_requesting === true,
        )
        ?? traces.find(
            (t) => t.registers && Object.keys(t.registers).length > 0,
        )
        ?? traces[0]
    );
}

function isAppFrame(f: SymFrame, hints: string[]): boolean {
    if (!f.package) {
        return false;
    }

    const mod = basename(f.package).toLowerCase();

    return hints.some((h) => h !== '' && mod.includes(h));
}

const SENTINEL_FRAME_RE = new RegExp(
    [
        '^(base::)?ImmediateCrash',
        '^base::debug::(BreakDebugger|CollectStackTrace|DumpWithoutCrashing|StackTrace)',
        '^crash_reporter::DumpWithoutCrashing',
        '^logging::',
        '^operator\\(\\)$',
        '^(?:absl::cleanup_internal::Storage<.*>::)?InvokeCallback(?:\\(|$)',
        '^(?:absl::Cleanup<.*>::)?~Cleanup(?:\\(|$)',
        '^~ErrnoLogMessage$',
        'CheckFailure',
        'CheckError',
        'NotReached',
        '^abort$',
        '^raise$',
        '^__assert',
        '^__cxa_throw$',
        '^std::terminate',
        'OnNoMemoryInternal',
        '^partition_alloc::internal::PartitionExcessiveAllocationSize',
        '^partition_alloc::TerminateBecauseOutOfMemory',
        '^base::internal::OnNoMemory',
        '^base::allocator::UnretainedDanglingRawPtrDetectedCrash',
        '^__fastfail',
        '^RtlFailFast',
        'CrashForException',
    ].join('|'),
);

export function isCrashMachineryFrame(f: SymFrame): boolean {
    const fn = frameFunction(f);

    return fn !== null && SENTINEL_FRAME_RE.test(fn);
}

const SIGNATURE_ONLY_FRAME_RE = new RegExp(
    [
        '^base::internal::RawPtrBackupRefImpl<.*>::ReportIfDangling\\(',
        '^base::raw_ptr<.*>::ReportIfDangling\\(',
        '^base::internal::UnretainedWrapper<.*>::(?:GetInternal|get)\\(',
        '^base::BindUnwrapTraits<.*>::Unwrap\\(',
        '^base::internal::Unwrap(?:<.*>)?\\(',
        '^base::internal::InvokeHelper<.*>::MakeItSo\\(',
        '^base::internal::Invoker<.*>::Run(?:Impl|Once)?\\(',
        '^base::OnceCallback<.*>::Run\\(',
    ].join('|'),
);

export function isSignatureExcludedFrame(f: SymFrame): boolean {
    const fn = frameFunction(f);

    return (
        isCrashMachineryFrame(f)
        || (fn !== null && SIGNATURE_ONLY_FRAME_RE.test(fn))
    );
}

function skipSignatureExcludedFrames(frames: SymFrame[]): SymFrame[] {
    let i = 0;
    while (i < frames.length && isSignatureExcludedFrame(frames[i])) {
        i++;
    }

    return i > 0 && i < frames.length ? frames.slice(i) : frames;
}

interface AnchoredSignatureRule {
    trigger: RegExp;
    triggerDepth: number;
    anchor: RegExp;
}

// Some diagnostic reports are captured by a shared handler long after the
// code which requested the report. Resume at the caller of a narrow,
// well-known anchor instead of grouping by the shared handler.
const ANCHORED_SIGNATURE_RULES: AnchoredSignatureRule[] = [
    {
        trigger: /::HandleBadMessage(?:\(|$)/,
        triggerDepth: 8,
        anchor: /^mojo::ReportBadMessage(?:\(|$)/,
    },
    {
        trigger: /^content::bad_message::ReceivedBadMessage(?:\(|$)/,
        triggerDepth: 4,
        anchor: /^content::bad_message::ReceivedBadMessage(?:\(|$)/,
    },
    {
        trigger:
            /^base::PersistentMemoryAllocator::DumpWithoutCrashing(?:\(|$)/,
        triggerDepth: 4,
        anchor: /^base::PersistentMemoryAllocator::DumpWithoutCrashing(?:\(|$)/,
    },
    {
        trigger: /HandleCheckErrorLogMessage(?:\(|$)/,
        triggerDepth: 8,
        anchor: /HandleCheckErrorLogMessage(?:\(|$)/,
    },
    {
        trigger: /^absl::ThrowStd[A-Za-z]+(?:\(|$)/,
        triggerDepth: 16,
        anchor: /^absl::ThrowStd[A-Za-z]+(?:\(|$)/,
    },
];

function applyAnchoredSignatureRule(frames: SymFrame[]): SymFrame[] {
    for (const rule of ANCHORED_SIGNATURE_RULES) {
        const triggered = frames.slice(0, rule.triggerDepth).some((frame) => {
            const fn = frameFunction(frame);
            return fn !== null && rule.trigger.test(fn);
        });
        if (!triggered) {
            continue;
        }

        let anchorIndex = -1;
        for (let i = 0; i < frames.length; i++) {
            const fn = frameFunction(frames[i]);
            if (fn !== null && rule.anchor.test(fn)) {
                anchorIndex = i;
            }
        }
        if (anchorIndex >= 0 && anchorIndex + 1 < frames.length) {
            return frames.slice(anchorIndex + 1);
        }
    }

    return frames;
}

function sha256Hex(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

export async function computeSignature(
    resp: SymbolicatorResponse,
    opts: { topN?: number; appHints?: string[] } = {},
): Promise<SignatureResult | null> {
    const topN = opts.topN ?? 5;
    const hints = (opts.appHints ?? [])
        .map((h) => h.toLowerCase().trim())
        .filter((h) => h !== '');

    const thread = crashingThread(resp);
    if (!thread || thread.frames.length === 0) {
        return null;
    }

    const appFrames =
        hints.length > 0
            ? thread.frames.filter((f) => isAppFrame(f, hints))
            : [];
    const withoutSentinels = skipSignatureExcludedFrames(
        appFrames.length > 0 ? appFrames : thread.frames,
    );
    const chosen = skipSignatureExcludedFrames(
        applyAnchoredSignatureRule(withoutSentinels),
    ).slice(0, topN);

    const labels = chosen.map((f) => frameLabel(f, resp.modules));
    const signature = sha256Hex(labels.join('\n'));
    const symbolicated = chosen.every((f) => f.status === 'symbolicated');

    return { signature, title: labels[0], symbolicated };
}

export async function fallbackSignature(
    resp: SymbolicatorResponse,
): Promise<SignatureResult> {
    const reason = resp.crash_reason?.trim() || 'no stacktrace';
    const signature = sha256Hex(`reason:${reason}`);

    return { signature, title: reason, symbolicated: false };
}

export function platformFromResponse(
    resp: SymbolicatorResponse,
): string | null {
    const raw = resp.system_info?.os_name?.trim() || null;
    if (!raw) {
        return null;
    }

    if (/^mac\s?os/i.test(raw)) {
        return 'macOS';
    }
    if (/^windows/i.test(raw)) {
        return 'Windows';
    }
    if (/^linux/i.test(raw)) {
        return 'Linux';
    }

    return raw;
}
