// @vitest-environment jsdom
// P2-E22-01 (#972) — which body an approval gets, and what happens when the
// Monaco half does not arrive.
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY CANNOT TEST.
//
// The dispatch and the fail-open guard, and nothing about the diff itself. Monaco
// does not run in jsdom — no layout, no `CSS`, no worker — so a test that mounted
// the real `ApprovalDiffView` here would either be asserting a mock or asserting
// an exception. The diff's own correctness lives in two places that can actually
// hold it: `lib/approval-diff.test.ts` for everything that is arithmetic (which
// payloads are diffable, apply order, the separator, the bound and what it
// reports), and one e2e that answers a real held permission with a real editor on
// screen.
//
// What is left here is the part with the highest cost of being wrong: **a card
// whose body fails to render must still be answerable, and must not be blank.**
// "The only safe answer to a question you cannot read is Deny, and a user denied
// into a corner turns autonomy UP to escape the friction" — `ToolInputPreview`'s
// header, and the reason `ContributionBoundary` grew a `fallback` for this.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';

/**
 * The lazy chunk, stubbed at the module boundary.
 *
 * `ApprovalPreview` reaches `ApprovalDiffView` through
 * `import('./ApprovalDiffView')`, so this is the seam, and stubbing it is what
 * lets the failure case be tested at all — the real module cannot be loaded here
 * (see the header).
 *
 * ⚠️ THE FAILURE IS A RENDER THROW, NOT A LOAD REJECTION, and the two are the same
 * code path. Both `React.lazy`'s rejection and a throw from the component's own
 * render surface as an exception DURING RENDER, which is the one thing only an
 * error boundary catches — so `ContributionBoundary` and its `fallback` are
 * exercised identically either way.
 *
 * It has to be a render throw rather than a rejected import for two reasons that
 * are both about caching: `vi.mock`'s factory runs ONCE, when the module is first
 * imported, so a flag flipped in a later test cannot make it throw; and
 * `React.lazy` caches its resolved module for the life of the page, so a file
 * whose first test loads the stub successfully can never see it fail afterwards.
 * A stub that consults the flag AT RENDER TIME sidesteps both.
 */
const diffView = vi.hoisted(() => ({ fail: false }));
vi.mock('./ApprovalDiffView', () => ({
  default: (props: { diff: { kind: string } }) => {
    if (diffView.fail) throw new Error('the Monaco chunk did not load');
    return <div data-approval-diff={props.diff.kind} />;
  },
}));

// Imported AFTER the mock is declared, which `vi.mock`'s hoisting makes safe.
const { ApprovalPreview } = await import('./ApprovalPreview');

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

/**
 * `colorScheme` is passed through verbatim, INCLUDING when it is omitted.
 *
 * Not a default parameter, and that is a trap this signature already fell into: a
 * default applies to an explicit `undefined` too, so `mount(EDIT, undefined)`
 * silently mounted with `'dark'` and the "caller cannot say which skin" test was
 * handed a diff where it meant to be handed nothing.
 */
async function mount(
  input: Record<string, unknown>,
  colorScheme?: 'light' | 'dark',
  tool?: string
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ApprovalPreview input={input} colorScheme={colorScheme} tool={tool} />);
  });
  // A second flush: `React.lazy` resolves on a microtask, so the first `act` ends
  // with the Suspense fallback still on screen. Without this the diff cases would
  // be asserting the panes and passing for the wrong reason.
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  diffView.fail = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const EDIT = { file_path: '/x/a.ts', old_string: 'before', new_string: 'after' };
const WRITE = { file_path: '/x/a.ts', content: ['one', 'two', ''].join('\n') };

describe('which body an approval gets', () => {
  it('gives an Edit the diff', async () => {
    const host = await mount(EDIT, 'dark');
    expect(host.querySelector('[data-approval-diff="edit"]')).not.toBeNull();
    expect(host.querySelector('[data-preview="edit"]')).toBeNull();
  });

  it('gives a Write the diff', async () => {
    const host = await mount(WRITE, 'dark');
    expect(host.querySelector('[data-approval-diff="write"]')).not.toBeNull();
  });

  it('gives a MultiEdit the diff', async () => {
    const host = await mount({ edits: [{ old_string: 'a', new_string: 'b' }] }, 'dark');
    expect(host.querySelector('[data-approval-diff="multi-edit"]')).not.toBeNull();
  });

  it('leaves a Bash command on the simple panes — one side is not a diff', async () => {
    const host = await mount({ command: 'npm run build' }, 'dark');
    expect(host.querySelector('[data-preview="command"]')?.textContent).toBe('npm run build');
    expect(host.querySelector('[data-approval-diff]')).toBeNull();
  });

  it('leaves a tool it has never heard of on the dump, which is the guarantee', async () => {
    const host = await mount({ some_future_key: 'whatever' }, 'dark');
    expect(host.querySelector('[data-preview="fallback"]')).not.toBeNull();
    expect(host.querySelector('[data-approval-diff]')).toBeNull();
  });

  it('renders the panes when the caller cannot say which skin the app is wearing', async () => {
    // Absent `colorScheme` means NO DIFF rather than a guess: Monaco has two skins
    // and a diff in the wrong one on a dark theme is unreadable. This is also the
    // shape of #261's failure — a render site that forgets to thread the context
    // loses the FEATURE and keeps the card, which is the right way round.
    const host = await mount(EDIT);
    expect(host.querySelector('[data-preview="edit"]')).not.toBeNull();
    expect(host.querySelector('[data-approval-diff]')).toBeNull();
  });
});

describe('fail-open: the body may fail, the QUESTION may not', () => {
  it('puts the panes back when the Monaco half will not render', async () => {
    diffView.fail = true;
    const host = await mount(EDIT, 'dark');
    // The diff is absent AND the payload is still on screen — the two halves of
    // the claim. A boundary that rendered its usual gap would satisfy the first
    // and leave the user signing for a blank.
    expect(host.querySelector('[data-approval-diff]')).toBeNull();
    const panes = host.querySelector('[data-preview="edit"]');
    expect(panes).not.toBeNull();
    expect(panes!.textContent).toContain('before');
    expect(panes!.textContent).toContain('after');
  });

  it('says so in the log rather than on the card', async () => {
    // §5.23's convention, and the boundary's own header: a broken contribution
    // does not shout at the user about an internal fault they cannot act on. The
    // fallback is a simpler TRUE thing, never an error message.
    diffView.fail = true;
    const host = await mount(EDIT, 'dark');
    expect(host.textContent).not.toMatch(/error|failed|could not load/i);
    // ⚠️ THE BOUNDARY'S OWN LINE, not just "something logged" (found in review).
    // React logs its own "The above error occurred in…" for every caught error, so a
    // bare `toHaveBeenCalled()` would keep passing if `ContributionBoundary` stopped
    // logging altogether — and that log line is the only record of which
    // contribution failed and whether it will be retried.
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      logged.some((args) => typeof args[0] === 'string' && args[0].includes('"approval-diff"'))
    ).toBe(true);
  });

  it('does not lose the payload of a MultiEdit either', async () => {
    diffView.fail = true;
    const host = await mount(
      {
        edits: [
          { old_string: 'ONE_OLD', new_string: 'ONE_NEW' },
          { old_string: 'TWO_OLD', new_string: 'TWO_NEW' },
        ],
      },
      'dark'
    );
    const panes = host.querySelector('[data-preview="edits"]');
    expect(panes).not.toBeNull();
    expect(panes!.textContent).toContain('ONE_OLD');
    expect(panes!.textContent).toContain('TWO_NEW');
  });
});

describe('a plan is shown as the document it is (#1071)', () => {
  // `ExitPlanMode` is Claude Code asking for its plan to be approved; the request
  // carries the plan as Markdown in `input.plan` (measured for #588). It used to
  // fall through to the key/value dump: one line, line breaks as backslash-n.
  const PLAN = { plan: '# Plan\n\n1. read the config\n2. **change** the port\n\nThen restart.' };

  it('renders the plan as headings, a list and prose', async () => {
    const host = await mount(PLAN, 'dark', 'ExitPlanMode');
    const body = host.querySelector('[data-approval-plan]');
    expect(body).not.toBeNull();
    expect(body!.querySelector('h1')?.textContent).toBe('Plan');
    expect([...body!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'read the config',
      'change the port',
    ]);
    expect(body!.querySelector('strong')?.textContent).toBe('change');
    expect(body!.textContent).toContain('Then restart.');
  });

  it('shows none of the raw markup, and no escaped line breaks', async () => {
    const host = await mount(PLAN, 'dark', 'ExitPlanMode');
    expect(host.textContent).not.toContain('# Plan');
    expect(host.textContent).not.toContain('**');
    expect(host.textContent).not.toContain('plan=');
    expect(host.textContent).not.toContain(String.fromCharCode(92) + 'n');
  });

  it('needs no colour scheme — a plan is not a diff', async () => {
    const host = await mount(PLAN, undefined, 'ExitPlanMode');
    expect(host.querySelector('[data-approval-plan] h1')).not.toBeNull();
  });

  it('is by NAME: a `plan` argument on any other tool is still an argument', async () => {
    // Rendering some other tool's argument as rich text would hide what was sent.
    const host = await mount(PLAN, 'dark', 'SomeOtherTool');
    expect(host.querySelector('[data-approval-plan]')).toBeNull();
    expect(host.textContent).toContain('# Plan');
  });

  it('falls back to the ordinary body when there is no plan to render', async () => {
    for (const input of [{}, { plan: '' }, { plan: '   ' }, { plan: 7 }, { plan: null }]) {
      const host = await mount(input, 'dark', 'ExitPlanMode');
      expect(host.querySelector('[data-approval-plan]')).toBeNull();
      root!.unmount();
      host.remove();
    }
  });

  it('cannot be used to put markup of the plan`s choosing on the bar', async () => {
    const host = await mount(
      { plan: '# Plan\n\n<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>' },
      'dark',
      'ExitPlanMode'
    );
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('[onerror]')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});
