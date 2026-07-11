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

export interface SymModule {
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

export interface SignatureResult {
    signature: string;
    title: string;
    symbolicated: boolean;
}

function basename(path: string): string {
    const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));

    return i >= 0 ? path.slice(i + 1) : path;
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

    return modules.find((m) => {
        const base = parseHex(m.image_addr);
        return base !== null && typeof m.image_size === 'number'
            && addr >= base && addr < base + m.image_size;
    }) ?? null;
}

export function frameLabel(f: SymFrame, modules?: SymModule[]): string {
    const fn = f.function ?? f.symbol;
    if (fn && fn.trim() !== '') {
        return fn.trim().replace(/\s+/g, ' ');
    }

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
        traces.find((t) =>
            t.is_requesting_thread === true || t.is_requesting === true
        )
            ?? traces.find((t) =>
                t.registers && Object.keys(t.registers).length > 0
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
        '^base::debug::(BreakDebugger|CollectStackTrace|StackTrace)',
        '^logging::',
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
        '^__fastfail',
        '^RtlFailFast',
        'CrashForException',
    ].join('|'),
);

function isSentinelFrame(f: SymFrame): boolean {
    const fn = f.function ?? f.symbol;

    return typeof fn === 'string' && SENTINEL_FRAME_RE.test(fn.trim());
}

function skipSentinelFrames(frames: SymFrame[]): SymFrame[] {
    let i = 0;
    while (i < frames.length && i < 8 && isSentinelFrame(frames[i])) {
        i++;
    }

    return i > 0 && i < frames.length ? frames.slice(i) : frames;
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(text),
    );

    return Array.from(new Uint8Array(digest)).map((b) =>
        b.toString(16).padStart(2, '0')
    ).join('');
}

export async function computeSignature(
    resp: SymbolicatorResponse,
    opts: { topN?: number; appHints?: string[] } = {},
): Promise<SignatureResult | null> {
    const topN = opts.topN ?? 5;
    const hints = (opts.appHints ?? []).map((h) => h.toLowerCase().trim())
        .filter((h) => h !== '');

    const thread = crashingThread(resp);
    if (!thread || thread.frames.length === 0) {
        return null;
    }

    const appFrames = hints.length > 0
        ? thread.frames.filter((f) => isAppFrame(f, hints))
        : [];
    const chosen = skipSentinelFrames(
        appFrames.length > 0 ? appFrames : thread.frames,
    ).slice(0, topN);

    const labels = chosen.map((f) => frameLabel(f, resp.modules));
    const signature = await sha256Hex(labels.join('\n'));
    const symbolicated = chosen.every((f) => f.status === 'symbolicated');

    return { signature, title: labels[0], symbolicated };
}

export async function fallbackSignature(
    resp: SymbolicatorResponse,
): Promise<SignatureResult> {
    const reason = resp.crash_reason?.trim() || 'no stacktrace';

    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`reason:${reason}`),
    );
    const signature = Array.from(new Uint8Array(digest)).map((b) =>
        b.toString(16).padStart(2, '0')
    )
        .join('');

    return { signature, title: reason, symbolicated: false };
}

export function platformFromResponse(
    resp: SymbolicatorResponse,
): string | null {
    const raw = resp.system_info?.os_name?.trim() || null;
    if (!raw) {
        return null;
    }

    // Apple crash reports carry the full "macOS 26.5.1 (25F80)" string —
    // collapse to a family name so filters group properly.
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
