// @vitest-environment jsdom
// "Jumping to a hit EXPANDS that block" (§5.31), asserted end to end inside
// the feed (P2-E17-02).
//
// This is the half of session find that cannot be proved by testing the
// provider: §5.31 decides that find searches everything the view is hiding —
// thinking folded to one line, tool detail collapsed, whole blocks dropped by
// a verbosity preset — and that jumping to a hit expands what it lands in. If
// the reveal did not reach the block renderers, find would scroll to a place
// where the matched text is still invisible, which is the same class of
// failure as searching the DOM: an answer that looks right and is not.
//
// It renders through the PANEL CONTRIBUTION, following FeedView.a11y's lesson:
// the thread from `PanelContext` is load-bearing (the surface is keyed by
// `cardId`), and a test that reached for the component directly would stay
// green with that thread cut.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import type { PanelContext } from '../extensibility/contributions';
import type { FeedBlockDto } from '../lib/feed';
import { findSurfaceFor, findSurfaceKey, resetFindSurfaces } from '../lib/find-surfaces';
import type { FeedFindSurface } from '../extensibility/find-providers';
import { FEED_SEQ_ATTR } from '../lib/feed-reveal';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

const BLOCKS: FeedBlockDto[] = [
  { seq: 1, kind: 'user', text: 'run the build', sidechain: false },
  {
    // hidden outright below `firehose`, and folded to one line even there
    seq: 2,
    kind: 'thinking',
    text: 'the error mentions ENOENT in the postbuild step',
    sidechain: false,
  },
  {
    // collapsed by default — and where an error string actually lives
    seq: 3,
    kind: 'tool',
    // multi-line on purpose: a collapsed Bash section shows its FIRST line, so
    // the buried line is the only honest "was this expanded?" probe
    tool: {
      name: 'Bash',
      category: 'shell',
      summary: 'npm run build',
      out: ['building the app', 'npm ERR! ENOENT'].join(String.fromCharCode(10)),
    },
    sidechain: false,
  },
  { seq: 4, kind: 'assistant', text: 'the build failed', sidechain: false },
];

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve(BLOCKS),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]) },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
  };
}

function ctx(): PanelContext {
  return {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'demo',
    visible: true,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    setView: () => {},
  };
}

const roots: Root[] = [];

async function mountFeed(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(feedPanel.render(ctx()));
  });
  // the backlog arrives on a promise
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

function surface(): FeedFindSurface {
  const s = findSurfaceFor(findSurfaceKey('card-1', 'feed'));
  if (!s) throw new Error('the feed published no find surface');
  return s as FeedFindSurface;
}

const blockEl = (host: HTMLElement, seq: number): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="${seq}"]`);

// the block RENDERERS are contributions: without them the feed renders empty
// boxes and every assertion about revealed content would pass vacuously
beforeAll(() => registerBuiltinContributions(rendererRegistry));

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  resetFindSurfaces();
  stubBridge();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  // jsdom does not paint, so rAF would otherwise never run our scroll
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  await initI18nForTests();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

describe('the feed publishes itself to the find bar (P2-E17-02)', () => {
  it('publishes under ITS OWN card’s key, and withdraws on unmount', async () => {
    await mountFeed();
    expect(findSurfaceFor(findSurfaceKey('card-1', 'feed'))?.kind).toBe('feed');
    // another card's key must never resolve to this feed
    expect(findSurfaceFor(findSurfaceKey('card-2', 'feed'))).toBeNull();

    const r = roots.pop()!;
    await act(async () => r.unmount());
    expect(findSurfaceFor(findSurfaceKey('card-1', 'feed'))).toBeNull();
  });

  it('REFUSES a jump to a block the view buffer does not hold', async () => {
    // The §5.31 v1 boundary. Returning false is what lets the bar render the
    // hit as snippet-only instead of scrolling somewhere arbitrary and calling
    // it the match.
    await mountFeed();
    let jumped = true;
    await act(async () => {
      jumped = surface().jumpTo(9_999);
    });
    expect(jumped).toBe(false);
  });
});

describe('jumping to a hit expands what the view was hiding (§5.31)', () => {
  it('brings back a block the VERBOSITY PRESET had dropped', async () => {
    // `normal` hides thinking entirely — and `quiet` hides exactly the tool
    // output error strings live in. A find that respected the filter would
    // scroll to a block that is not in the list.
    const host = await mountFeed();
    expect(blockEl(host, 2)).toBeNull();

    let jumped = false;
    await act(async () => {
      jumped = surface().jumpTo(2);
    });
    expect(jumped).toBe(true);
    expect(blockEl(host, 2)).not.toBeNull();
  });

  it('UNFOLDS the thinking it lands in, rather than landing on a one-line summary', async () => {
    const host = await mountFeed();
    await act(async () => {
      surface().jumpTo(2);
    });
    const block = blockEl(host, 2)!;
    expect(block.querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(block.textContent).toContain('the error mentions ENOENT in the postbuild step');
  });

  it('opens a collapsed tool block’s OUT, which is where the error string is', async () => {
    const host = await mountFeed();
    const before = blockEl(host, 3)!;
    expect(before.textContent).not.toContain('npm ERR! ENOENT');
    expect(before.querySelector('[aria-expanded="true"]')).toBeNull();

    await act(async () => {
      surface().jumpTo(3);
    });
    const after = blockEl(host, 3)!;
    expect(after.textContent).toContain('npm ERR! ENOENT');
    expect(after.querySelector('[aria-expanded="true"]')).not.toBeNull();
  });

  it('marks the block it is sitting on, and moves the mark when it steps', async () => {
    const host = await mountFeed();
    await act(async () => {
      surface().jumpTo(3);
    });
    expect(blockEl(host, 3)!.style.outline).not.toBe('');
    expect(blockEl(host, 1)!.style.outline).toBe('');

    await act(async () => {
      surface().jumpTo(1);
    });
    expect(blockEl(host, 1)!.style.outline).not.toBe('');
    expect(blockEl(host, 3)!.style.outline).toBe('');
    // ...but a block revealed earlier STAYS expanded: stepping back and forth
    // through a result set must not re-fold what you already looked at
    expect(blockEl(host, 3)!.textContent).toContain('npm ERR! ENOENT');
  });

  it('clear() puts the view back the way find found it', async () => {
    const host = await mountFeed();
    await act(async () => {
      surface().jumpTo(2);
    });
    expect(blockEl(host, 2)).not.toBeNull();

    await act(async () => {
      surface().clear();
    });
    expect(blockEl(host, 2)).toBeNull();
    expect(blockEl(host, 3)!.textContent).not.toContain('npm ERR! ENOENT');
  });
});
