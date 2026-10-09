import { assert, assertEquals } from '@std/assert';

import {
    collapseCppName,
    groupsPage,
    stackHtml,
    symbolsPage,
} from '../src/ui.ts';

const MONSTER =
    'base::internal::Invoker<base::internal::FunctorTraits<base::IgnoreArgs<tabs::TabInterface*, , void>(base::RepeatingCallback<void ()>)::{lambda(base::RepeatingCallback<void ()> const, tabs::TabInterface*)#1}&, base::RepeatingCallback<void ()> const&>, base::internal::BindState<false, false, false, base::IgnoreArgs<tabs::TabInterface*, , void>(base::RepeatingCallback<void ()>)::{lambda(base::RepeatingCallback<void ()>, tabs::TabInterface*)#1}, base::RepeatingCallback<void ()> >, void (tabs::TabInterface*)>::Run(base::internal::BindStateBase*, tabs::TabInterface*)';

Deno.test('collapseCppName folds huge template arguments', () => {
    assertEquals(
        collapseCppName(MONSTER),
        'base::internal::Invoker<\u{2026}>::Run(base::internal::BindStateBase*, tabs::TabInterface*)',
    );
});

Deno.test('collapseCppName keeps short and simple names untouched', () => {
    for (
        const name of [
            'main',
            'content::HandleDebugURL(GURL const&, ui::PageTransition, bool)',
            'std::vector<int>::push_back(int&&)',
            '-[NSApplication run]',
            'content::(anonymous namespace)::CrashBrowserProcessIntentionally()',
        ]
    ) {
        assertEquals(collapseCppName(name), name);
    }
});

Deno.test('collapseCppName folds long lambda bodies', () => {
    const name =
        'SomeVeryLongClassNameIndeed::Method()::{lambda(base::RepeatingCallback<void ()> const&, tabs::TabInterface*)#1}::operator()(int) const';
    assertEquals(
        collapseCppName(name),
        'SomeVeryLongClassNameIndeed::Method()::{lambda}::operator()(int) const',
    );
});

Deno.test('collapseCppName is not fooled by comparison operators', () => {
    const name =
        'bool std::operator<(std::pair<AVeryLongTypeNameForTesting, AVeryLongTypeNameForTesting> const&, std::pair<AVeryLongTypeNameForTesting, AVeryLongTypeNameForTesting> const&)';
    const out = collapseCppName(name);
    assert(out.startsWith('bool std::operator<('));
    assert(out.includes('std::pair<\u{2026}>'));
});

Deno.test('collapseCppName leaves unbalanced input untouched', () => {
    const broken =
        'base::internal::Invoker<base::OnceCallback<void (SomeExtremelyLongTypeName, AnotherExtremelyLongTypeName'
        + '::Run(base::internal::BindStateBase*)';
    assertEquals(collapseCppName(broken), broken);
});

// Renders the one page no HTTP test exercises with populated rows; catches
// template-compile errors (Eta pastes <% %> blocks verbatim into a function).
Deno.test('groupsPage renders populated rows', () => {
    const html = groupsPage({
        groups: [{
            id: 1,
            signature: 'abcdef0123456789abcdef0123456789',
            title: 'content::RenderWidgetHostImpl::OnKeyboardEvent()',
            first_seen: 1_780_000_000_000,
            last_seen: 1_781_000_000_000,
            report_count: 3,
            products: 'Helium',
            versions: '0.14.3.1,0.14.2.1',
            platforms: 'macOS',
            unsymbolicated: 1,
        }],
        stats: [],
        breakdown: 'total',
        options: {
            products: ['Helium'],
            versions: ['0.14.3.1'],
            platforms: ['macOS'],
            ptypes: ['browser'],
        },
        filter: { product: 'Helium' },
    }, 'jj');
    assert(html.includes('OnKeyboardEvent'));
    assert(html.includes('<span class="pill">0.14.3.1</span>'));
    assert(html.includes('<span class="pill">macOS</span>'));
    assert(html.includes('missing symbols'));
    assert(html.includes('jj'));
    assert(
        html.includes(
            '<link rel="icon" type="image/svg+xml" href="/static/favicon.svg">',
        ),
    );
    assert(
        html.includes(
            '<a class="brand" href="/" aria-label="minidumpster"><img src="/static/favicon.svg" alt=""></a>',
        ),
    );
});

Deno.test('stackHtml folds consecutive crash machinery frames', () => {
    const html = stackHtml({
        status: 'completed',
        stacktraces: [{
            thread_id: 7,
            is_requesting_thread: true,
            frames: [
                { function: 'base::ImmediateCrash()' },
                { function: 'logging::LogMessage::HandleFatal()' },
                {
                    function:
                        'absl::cleanup_internal::Storage<Callback>::InvokeCallback()',
                },
                {
                    function:
                        'base::allocator::UnretainedDanglingRawPtrDetectedCrash(unsigned long)',
                },
                {
                    function:
                        'base::internal::RawPtrBackupRefImpl<1>::ReportIfDangling(content::WebContents*)',
                },
                {
                    function:
                        'base::internal::UnretainedWrapper<content::WebContents>::get() const',
                },
                {
                    function:
                        'base::internal::Invoker<...>::RunOnce(base::internal::BindStateBase*)',
                },
                { function: 'content::ActualCrashOrigin()' },
            ],
        }],
    }, false);

    assert(html.includes('7 folded frames'));
    assert(html.includes('data-stack-fold-row="stack-fold-0-0" hidden'));
    assert(html.includes('base::ImmediateCrash()'));
    assert(html.includes('content::ActualCrashOrigin()'));
});

Deno.test('stackHtml does not fold mid-stack crash machinery frames', () => {
    const html = stackHtml({
        status: 'completed',
        stacktraces: [{
            thread_id: 7,
            is_requesting_thread: true,
            frames: [
                { function: 'content::Caller()' },
                { function: 'operator()' },
                { function: 'InvokeCallback()' },
                { function: '~Cleanup()' },
                { function: 'content::Callee()' },
            ],
        }],
    }, false);

    assert(!html.includes('folded frames'));
    assert(!html.includes('data-stack-fold-row'));
    assert(html.includes('InvokeCallback()'));
});

Deno.test('symbolsPage renders release and installed bundle state', () => {
    const html = symbolsPage({
        artifacts: [{
            repo: 'imputnet/helium-windows',
            artifact_id: 42,
            release_tag: '0.14.5.1',
            artifact_name: 'build-artifact-arm64',
            status: 'ingested',
            attempts: 1,
            next_attempt_at: 0,
            error: null,
            ingested_at: 1_780_000_000_000,
        }, {
            repo: 'imputnet/helium-macos',
            artifact_id: 43,
            release_tag: '0.14.5.1',
            artifact_name: 'github_build_artifact_x86_64',
            status: 'pending',
            attempts: 2,
            next_attempt_at: 1_790_000_000_000,
            error: 'temporary failure',
            ingested_at: null,
        }],
        bundles: [{
            id: 'helium-0.14.5.1',
            updatedAt: 1_780_000_000_000,
        }],
    }, 'jj');

    assert(html.includes('symbols installed'));
    assert(html.includes('Win'));
    assert(html.includes('arm64'));
    assert(html.includes('macOS'));
    assert(html.includes('x86_64'));
    assert(html.includes('temporary failure'));
    assert(html.includes('helium-0.14.5.1'));
    assert(html.includes('<span class="muted">symbols</span>'));
    assert(!html.includes('href="/symbols"'));
});
