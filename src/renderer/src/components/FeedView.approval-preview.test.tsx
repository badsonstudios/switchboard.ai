// @vitest-environment jsdom
// The per-card approval bar shows what the call would DO (#953).
//
// `ToolInputPreview.test.tsx` pins the component. This file pins the WIRING,
// and it is the half that regressed: the bug was never in a helper, it was two
// inline branches at the render site — `command`, and `old_string` +
// `new_string` — so a held `Write` rendered its heading and stopped. A test of
// the preview alone would have stayed green through exactly that, because the
// preview did not exist and nothing called it.
//
// It renders `FeedView` directly rather than through the panel contribution
// because the held request is a PROP on it, and the contribution's job — to
// source that prop from the store — is not what is under test here.
//
// ── TWO ROUTES SINCE #972, AND BOTH ARE WIRING ──────────────────────────────
//
// The bar's body is `ApprovalPreview` now, which sends a diffable payload to a
// Monaco diff and everything else to the panes. So this file pins two things:
//
//   * the groups WITHOUT a `colorScheme` are the panes route — the fail-open
//     fallback and the non-diff tools, which is every assertion this file already
//     made, unchanged;
//   * the group at the bottom is the DIFF route, and it exists because #261's
//     lesson is that a prop threaded through a render site is dead the moment
//     someone forgets it, and this one fails SILENTLY: absent `colorScheme` means
//     "no diff", so a forgotten thread leaves the card working and the feature
//     simply gone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';

// Monaco cannot run in jsdom, and the real diff's correctness is not what this
// file is for — see `ApprovalPreview.test.tsx` and `lib/approval-diff.test.ts`.
// The stub only has to prove which route the bar took.
vi.mock('./ApprovalDiffView', () => ({
  default: (props: { diff: { kind: string } }) => (
    <div data-approval-diff={props.diff.kind} />
  ),
}));

const { FeedView } = await import('./FeedView');

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** The slice of the preload bridge FeedView reaches for while mounting. */
function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]) },
  };
}

let root: Root | null = null;

/**
 * one held request, rendered where the user actually meets it
 *
 * `colorScheme` is OMITTED by default and passed through verbatim, never
 * defaulted: absent is what sends the body down the panes route, and a default
 * would quietly send every caller down the diff one.
 */
async function mountHeld(
  tool: string,
  input: Record<string, unknown>,
  colorScheme?: 'light' | 'dark'
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <FeedView
        sessionId="live-1"
        cardId="card-1"
        visible
        controlsLock={null}
        approval={{ requestId: 'r1', tool, input }}
        onDecide={() => {}}
        colorScheme={colorScheme}
      />
    );
  });
  // `React.lazy` resolves on a microtask, so without a second flush the diff
  // route would still be showing its Suspense fallback — the panes — and the
  // group below would pass for exactly the reason it exists to rule out.
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  stubBridge();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

describe('the bar a single session asks from is never blank', () => {
  it('shows the contents a Write would put on disk, not just its path', async () => {
    // the whole bug in one assertion: this used to be the path and nothing
    // else, and Allow on it was a signature on a page nobody had read
    const host = await mountHeld('Write', {
      file_path: 'C:/Projects/app/config.ts',
      content: 'export const endpoint = "https://prod.example";\n',
    });
    expect(host.textContent).toContain('Allow Write?');
    expect(host.querySelector('[data-preview="content"]')).not.toBeNull();
    expect(host.textContent).toContain('https://prod.example');
  });

  it('shows every change a MultiEdit would make', async () => {
    const host = await mountHeld('MultiEdit', {
      file_path: 'C:/Projects/app/a.ts',
      edits: [
        { old_string: 'DEBUG = true', new_string: 'DEBUG = false' },
        { old_string: 'port = 80', new_string: 'port = 443' },
      ],
    });
    expect(host.textContent).toContain('2 changes');
    expect(host.textContent).toContain('DEBUG = false');
    expect(host.textContent).toContain('port = 443');
  });

  it('names the notebook it is about to edit AND shows the new cell', async () => {
    // `NotebookEdit` keys its path `notebook_path`, so before #953 the summary
    // line came back empty too: this was the one held tool that named nothing
    const host = await mountHeld('NotebookEdit', {
      notebook_path: 'C:/Projects/app/run.ipynb',
      cell_id: 'c7',
      new_source: 'df.to_csv("out.csv")',
    });
    expect(host.textContent).toContain('C:/Projects/app/run.ipynb');
    expect(host.textContent).toContain('df.to_csv("out.csv")');
  });

  it('dumps a tool it has never heard of rather than rendering silence', async () => {
    const host = await mountHeld('SomeToolFromNextRelease', {
      file_path: 'C:/Projects/app/a.ts',
      strategy: 'rewrite-in-place',
    });
    expect(host.querySelector('[data-preview="fallback"]')!.textContent).toContain(
      'strategy="rewrite-in-place"'
    );
  });

  it('still renders a shell command the way it always did', async () => {
    const host = await mountHeld('Bash', { command: 'git push --force' });
    expect(host.querySelector('[data-preview="command"]')!.textContent).toBe('git push --force');
  });
});

describe('and the bar threads the theme through, or the diff is silently absent', () => {
  it('sends a Write to the diff once it knows which skin the app is wearing', async () => {
    const host = await mountHeld(
      'Write',
      { file_path: 'C:/Projects/app/config.ts', content: 'export const x = 1;' },
      'dark'
    );
    expect(host.querySelector('[data-approval-diff="write"]')).not.toBeNull();
    // and the panes are NOT also on screen: two bodies for one question is the
    // failure §5.16 is most careful about, one surface over
    expect(host.querySelector('[data-preview="content"]')).toBeNull();
  });

  it('sends a MultiEdit to the diff, where apply order can actually be shown', async () => {
    const host = await mountHeld(
      'MultiEdit',
      {
        file_path: 'C:/Projects/app/a.ts',
        edits: [
          { old_string: 'DEBUG = true', new_string: 'DEBUG = false' },
          { old_string: 'port = 80', new_string: 'port = 443' },
        ],
      },
      'dark'
    );
    expect(host.querySelector('[data-approval-diff="multi-edit"]')).not.toBeNull();
  });

  it('still sends a Bash command to the panes, theme or no theme', async () => {
    const host = await mountHeld('Bash', { command: 'git push --force' }, 'dark');
    expect(host.querySelector('[data-preview="command"]')!.textContent).toBe('git push --force');
    expect(host.querySelector('[data-approval-diff]')).toBeNull();
  });
});
