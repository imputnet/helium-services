export interface AppleCrashMeta {
    process: string | null;
    identifier: string | null;
    version: string | null;
    incidentId: string | null;
    osVersion: string | null;
    hardwareModel: string | null;
}

function firstMatch(text: string, re: RegExp): string | null {
    const m = re.exec(text);
    return m ? m[1].trim() : null;
}

export function looksLikeAppleCrashReport(text: string): boolean {
    if (text.trimStart().startsWith('{')) {
        return false; // raw .ips JSON
    }

    return /^Thread \d+.*:/m.test(text) && /^Binary Images:/m.test(text)
        && /^Process:/m.test(text);
}

export function parseAppleCrashMeta(text: string): AppleCrashMeta {
    return {
        process: firstMatch(text, /^Process:\s+(.+?)(?:\s+\[\d+\])?\s*$/m),
        identifier: firstMatch(text, /^Identifier:\s+(\S+)/m),
        version: firstMatch(text, /^Version:\s+(\S+)/m),
        incidentId: firstMatch(
            text,
            /^Incident Identifier:\s+([0-9A-Fa-f-]+)/m,
        ),
        osVersion: firstMatch(text, /^OS Version:\s+(.+)$/m),
        hardwareModel: firstMatch(text, /^Hardware Model:\s+(.+)$/m),
    };
}

function archFromCodeType(text: string): string {
    const codeType = firstMatch(text, /^Code Type:\s+(.+)$/m) ?? '';

    if (/arm-?64/i.test(codeType)) {
        return 'arm64';
    }
    if (/x86[-_ ]?64/i.test(codeType)) {
        return 'x86_64';
    }

    return 'unknown';
}

// Modern image line: `0xA - 0xB name (version) <uuid> path` (no arch column).
const MODERN_IMAGE_RE =
    /^(\s*0x[0-9a-fA-F]+\s*-\s*0x[0-9a-fA-F]+\s+)(\S.*?)\s+(\([^)]*\)\s+)?(<[0-9a-fA-F-]+>\s+.*)$/;

// `Thread N:: name` / `Thread N Crashed:: name` (modern double-colon form).
const MODERN_THREAD_RE = /^Thread (\d+)( Crashed)?::\s*(.*?)\s*$/;

/**
 * Rewrite a modern translated report into the classic format Symbolicator's
 * parser understands. Classic-format input passes through unchanged.
 */
export function normalizeAppleCrashReport(text: string): string {
    // Keep only the translated section: drop the banner and the trailing
    // "Full Report" JSON blob.
    let body = text.replace(/\r\n/g, '\n');
    const fullReport = body.search(/^-+\n+Full Report\n/m);
    if (fullReport >= 0) {
        body = body.slice(0, fullReport);
    }
    body = body.replace(/^-+\n+Translated Report.*\n-+\n/m, '');

    // Modern reports carry four fractional-second digits ("20:14:06.2645"),
    // which symbolicator releases before 2026-03 reject ("invalid timestamp");
    // truncate to the three digits every parser version accepts.
    body = body.replace(
        /^((?:Date\/Time|Launch Time):\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\d+/gm,
        '$1',
    );

    const arch = archFromCodeType(body);
    let inBinaryImages = false;
    const out: string[] = [];
    for (const line of body.split('\n')) {
        if (/^Binary Images:/.test(line)) {
            inBinaryImages = true;
        } else if (inBinaryImages && line.trim() === '') {
            inBinaryImages = false;
        }

        if (inBinaryImages) {
            const img = MODERN_IMAGE_RE.exec(line);
            // Classic lines already end the name field with an arch token —
            // only modern lines (no arch column) get one inserted.
            if (img && !/\s(?:arm64e?|x86_64|i386|unknown)$/.test(img[2])) {
                out.push(`${img[1]}${img[2]} ${arch} ${img[3] ?? ''}${img[4]}`);
                continue;
            }
        }

        const thread = MODERN_THREAD_RE.exec(line);
        if (thread) {
            const [, num, crashed, name] = thread;
            // Split the name off Dispatch-queue suffixes the modern header
            // carries, matching the classic `Thread N name:` line format.
            if (name !== '') {
                out.push(`Thread ${num} name:  ${name}`);
            }
            out.push(`Thread ${num}${crashed ?? ''}:`);
            continue;
        }

        out.push(line);
    }

    return out.join('\n');
}
