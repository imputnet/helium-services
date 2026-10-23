import { crashingThread, type SymbolicatorResponse } from './signature.ts';

const DISCARD_RULES = [
    {
        reason: 'unusable GPU process',
        functions: ['IntentionallyCrashBrowserForUnusableGpuProcess'],
    },
    {
        reason: 'no usable Linux sandbox',
        functions: ['ZygoteHostImpl::Init'],
    },
    {
        reason: 'GPU hang recovery',
        functions: ['DeliberatelyTerminateToRecoverFromHang'],
    },
    {
        reason: 'Windows hung-input diagnostic dump',
        functions: ['DumpProcessForHungInputThread'],
    },
    {
        reason: 'out of memory',
        functions: [
            'TerminateBecauseOutOfMemory',
            'OnNoMemoryInternal',
            'PartitionExcessiveAllocationSize',
            'PartitionOutOfMemoryWithLotsOfUncommitedPages',
            'PartitionOutOfMemoryWithLargeVirtualSize',
            'PartitionOutOfMemoryMappingFailure',
            'PartitionOutOfMemoryCommitFailure',
            'PartitionRoot::OutOfMemory',
            'HandlePoolAllocFailureOutOfVASpace',
            'HandlePoolAllocFailureOutOfCommitCharge',
            'IcuOutOfMemory',
            'FX_OutOfMemoryTerminate',
            'FatalProcessOutOfMemory',
            'FatalOutOfMemoryHandlerImpl',
            'GlobalFatalOutOfMemoryHandlerImpl',
            'PartitionsOutOfMemoryUsing',
        ],
    },
    {
        reason: 'Windows GDI resource exhaustion',
        functions: [
            'CrashIfCannotAllocateSmallBitmap',
            'CrashIfExcessiveHandles',
            'CrashIfPagefileUsageTooLarge',
            'CrashIfPrivateUsageTooLarge',
            'CollectChildGDIUsageAndDie',
        ],
    },
] as const;

export function crashDiscardReason(
    response: SymbolicatorResponse,
): string | null {
    const frames = crashingThread(response)?.frames ?? [];
    const symbols = frames.flatMap((frame) =>
        [frame.function, frame.symbol].filter(
            (symbol): symbol is string => typeof symbol === 'string',
        ),
    );

    if (response.crash_reason?.startsWith('Out of Memory')) {
        return 'out of memory';
    }

    for (const rule of DISCARD_RULES) {
        if (
            symbols.some((symbol) =>
                rule.functions.some((fn) => symbol.includes(fn)),
            )
        ) {
            return rule.reason;
        }
    }

    return null;
}
