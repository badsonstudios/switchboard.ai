// @vitest-environment jsdom
// #1130 — a burst of Read / Grep / Glob calls is ONE row in the conversation.
//
// What folds and where a run ends is `lib/feed-folds`'s and is tested there.
// This file owns what only the mounted Feed can answer:
//
//   * the row replaces the run, and opening it shows every call as it always was
//   * find can still land on a call inside a shut fold (the fold opens)
//   * the row is a stop on the arrow-key walk, like every other expander
//   * the structure the rest of the Feed stands on is intact: blocks are still
//     direct children of their group, and the row never borrows a block's seq
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import type { PanelContext } from '../extensibility/contributions';
import type { FeedBlockDto } from '../lib/feed';
import {
  findSurfaceFor,
  findSurfaceKey,
  resetFindSurfaces,
  type FeedFindSurface,
} from '../lib/find-surfaces';
import { FEED_SEQ_ATTR } from '../lib/feed-reveal';
import { FEED_STOP_SELECTOR } from '../lib/feed-keys';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

const call = (seq: number, name: string, summary: string, over: Partial<FeedBlockDto> = {}): FeedBlockDto =>
  ({
    seq,
    kind: 'tool',
    sidechain: false,
    tool: { name, category: 'read', summary, detail: `{"q":"${summary}"}`, out: 'ok' },
    ...over,
  });

/** a prompt, a sentence, a burst of five, a sentence, an edit, a lone Read */
const CONVERSATION: FeedBlockDto[] = [
  { seq: 1, kind: 'user', text: 'find the bug', sidechain: false },
  { seq: 2, kind: 'assistant', text: 'looking', sidechain: false },
  call(3, 'Grep', 'src/lib'),
  call(4, 'Glob', '**/*.ts'),
  call(5, 'Read', 'src/lib/feed.ts'),
  call(6, 'Grep', 'NEEDLE_IN_A_FOLD'),
  call(7, 'Read', 'src/lib/last.ts'),
  { seq: 8, kind: 'assistant', text: 'found it', sidechain: false },
  {
    seq: 9,
    kind: 'tool',
    sidechain: false,
    tool: { name: 'Edit', category: 'edit', summary: 'src/lib/feed.ts', filePath: 'src/lib/feed.ts', oldString: 'a', newString: 'b' },
  },
  call(10, 'Read', 'src/alone.ts'),
];

let BLOCKS: FeedBlockDto[] = CONVERSATION;
/** the Feed's live subscription, so a test can stream a block in */
let push: ((p: { sessionId: string; block: FeedBlockDto }) => void) | null = null;

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve(BLOCKS),
      onBlock: (fn: typeof push) => {
        push = fn;
        return () => {};
      },
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
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    controlsLock: null,
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
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

const seqs = (host: HTMLElement): number[] =>
  [...host.querySelectorAll<HTMLElement>(`[${FEED_SEQ_ATTR}]`)].map((el) => Number(el.getAttribute(FEED_SEQ_ATTR)));
const folds = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-feed-fold]')];
const foldButton = (host: HTMLElement): HTMLButtonElement =>
  folds(host)[0].querySelector<HTMLButtonElement>('button[data-feed-expander]')!;
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

function surface(): FeedFindSurface {
  const s = findSurfaceFor(findSurfaceKey('card-1', 'feed'));
  if (!s) throw new Error('the feed published no find surface');
  return s as FeedFindSurface;
}

beforeAll(() => registerBuiltinContributions(rendererRegistry));

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  BLOCKS = CONVERSATION;
  push = null;
  document.body.innerHTML = '';
  resetFindSurfaces();
  stubBridge();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  // jsdom has no layout: a jump's scroll is not what these tests are about
  Element.prototype.scrollIntoView = () => {};
  await initI18nForTests();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

describe('a burst of looking around is one row (#1130)', () => {
  it('draws the five calls as one row that says what they were', async () => {
    const host = await mountFeed();
    expect(folds(host)).toHaveLength(1);
    // the run's own blocks are not in the document; everything else is
    expect(seqs(host)).toEqual([1, 2, 8, 9, 10]);
    const row = folds(host)[0];
    expect(row.textContent).toContain('Explored the code');
    expect(row.textContent).toContain('3 searches');
    expect(row.textContent).toContain('2 files read');
    // the newest call, so a burst still running shows where it has got to
    expect(row.textContent).toContain('Read src/lib/last.ts');
    expect(foldButton(host).getAttribute('aria-expanded')).toBe('false');
  });

  // acceptance 2, and the ticket's boundary rule
  it('never folds an edit, the prose around it, or a lone Read', async () => {
    const host = await mountFeed();
    expect(host.querySelector('[data-feed-box="edit"]')).not.toBeNull();
    expect(host.querySelector(`[${FEED_SEQ_ATTR}="10"] [data-feed-box="tool"]`)).not.toBeNull();
    expect(host.textContent).toContain('looking');
    expect(host.textContent).toContain('found it');
  });

  it('opens onto every call, in order, drawn as it always was — and shuts again', async () => {
    const host = await mountFeed();
    await click(foldButton(host));
    expect(seqs(host)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(foldButton(host).getAttribute('aria-expanded')).toBe('true');
    // each is the ordinary tool row, with its own expander
    for (const seq of [3, 4, 5, 6, 7]) {
      const block = host.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="${seq}"]`)!;
      expect(block.dataset.feedBlock).toBe('tool');
      expect(block.querySelector('[data-feed-box="tool"] button[data-feed-expander]')).not.toBeNull();
    }
    // the row stays, above the first of them, as the way to shut it
    const row = folds(host)[0];
    expect(row.nextElementSibling?.getAttribute(FEED_SEQ_ATTR)).toBe('3');
    await click(foldButton(host));
    expect(seqs(host)).toEqual([1, 2, 8, 9, 10]);
  });

  it('the box around the row opens it too, like a tool row’s', async () => {
    const host = await mountFeed();
    await click(folds(host)[0].querySelector<HTMLElement>('[data-feed-box="fold"]')!);
    expect(seqs(host)).toContain(5);
  });

  // ⚠️ the row is furniture. A jump resolves a block by `data-feed-seq` and
  // paints marks inside it; a row that borrowed its head's seq would take both.
  it('⚠️ the row is not a block and carries no block’s seq', async () => {
    const host = await mountFeed();
    const row = folds(host)[0];
    expect(row.hasAttribute('data-feed-block')).toBe(false);
    expect(row.hasAttribute(FEED_SEQ_ATTR)).toBe(false);
    expect(host.querySelectorAll(`[${FEED_SEQ_ATTR}="3"]`)).toHaveLength(0);
    await click(foldButton(host));
    expect(host.querySelectorAll(`[${FEED_SEQ_ATTR}="3"]`)).toHaveLength(1);
  });

  // what `use-feed-skipping` stands on: every block a direct child of a group,
  // and so is the row
  it('⚠️ keeps every block a direct child of its group, open or shut', async () => {
    const host = await mountFeed();
    const check = (): void => {
      for (const el of host.querySelectorAll<HTMLElement>('[data-feed-block], [data-feed-fold]')) {
        expect(el.parentElement?.hasAttribute('data-feed-group')).toBe(true);
      }
    };
    check();
    await click(foldButton(host));
    check();
  });
});

describe('find reaches a call inside a shut fold (#1130)', () => {
  it('a jump to a folded call opens the fold and lands on the call', async () => {
    const host = await mountFeed();
    expect(host.querySelector(`[${FEED_SEQ_ATTR}="6"]`)).toBeNull();
    let jumped = false;
    await act(async () => {
      jumped = surface().jumpTo(6);
    });
    expect(jumped).toBe(true);
    // the whole run is on screen, not just the hit: a fold is open or it is not
    expect(seqs(host)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(host.querySelector(`[${FEED_SEQ_ATTR}="6"]`)!.textContent).toContain('NEEDLE_IN_A_FOLD');
    expect(foldButton(host).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the fold and the keyboard (#1130)', () => {
  it('the row is a stop on the arrow-key walk, and a real button', async () => {
    const host = await mountFeed();
    const stops = [...host.querySelectorAll<HTMLElement>(FEED_STOP_SELECTOR)];
    const button = foldButton(host);
    expect(stops).toContain(button);
    expect(button.tagName).toBe('BUTTON');
    // one stop for the whole burst, where there used to be five
    const inRun = stops.filter((el) => el.closest('[data-feed-fold]'));
    expect(inRun).toHaveLength(1);
  });

  it('Enter on the row opens it, and focus stays on the row', async () => {
    const host = await mountFeed();
    const button = foldButton(host);
    await act(async () => {
      button.focus();
    });
    // a native button: Enter is a click
    await click(button);
    expect(seqs(host)).toContain(4);
    expect(document.activeElement).toBe(foldButton(host));
  });
});

describe('a burst still in progress (#1130)', () => {
  it('a new call joins the fold, and the row counts it', async () => {
    BLOCKS = CONVERSATION.slice(0, 7); // ends on the fifth call
    const host = await mountFeed();
    expect(folds(host)[0].textContent).toContain('2 files read');
    await act(async () => {
      push!({ sessionId: 'live-1', block: call(8, 'Read', 'src/lib/newest.ts') });
    });
    expect(folds(host)).toHaveLength(1);
    expect(folds(host)[0].textContent).toContain('3 files read');
    expect(folds(host)[0].textContent).toContain('Read src/lib/newest.ts');
    expect(seqs(host)).toEqual([1, 2]);
  });

  // opened by hand, it stays open as the run grows
  it('an open fold stays open, and shows the new call', async () => {
    BLOCKS = CONVERSATION.slice(0, 7);
    const host = await mountFeed();
    await click(foldButton(host));
    await act(async () => {
      push!({ sessionId: 'live-1', block: call(8, 'Read', 'src/lib/newest.ts') });
    });
    expect(seqs(host)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('the first two calls are plain rows; the third folds all three', async () => {
    BLOCKS = CONVERSATION.slice(0, 4); // prompt, sentence, two calls
    const host = await mountFeed();
    expect(folds(host)).toHaveLength(0);
    expect(seqs(host)).toEqual([1, 2, 3, 4]);
    await act(async () => {
      push!({ sessionId: 'live-1', block: call(5, 'Read', 'src/lib/feed.ts') });
    });
    expect(folds(host)).toHaveLength(1);
    expect(seqs(host)).toEqual([1, 2]);
  });
});

// Found in review: two calls are two ordinary rows, and the third used to turn
// all three into one SHUT row — taking a detail you had opened, or the row the
// keyboard was standing on, out of the document.
describe('a call you are reading is not folded away under you (#1130)', () => {
  const detailOf = (host: HTMLElement, seq: number): HTMLElement | null =>
    host.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="${seq}"] pre`);

  it('a row you opened stays open, in place, when the third call arrives', async () => {
    BLOCKS = CONVERSATION.slice(0, 4); // prompt, sentence, Grep, Glob
    const host = await mountFeed();
    await click(host.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="4"] button[data-feed-expander]`)!);
    expect(detailOf(host, 4)).not.toBeNull();
    await act(async () => {
      push!({ sessionId: 'live-1', block: call(5, 'Read', 'src/lib/feed.ts') });
    });
    // the run folds, but OPEN: the row you were reading has not moved or shut
    expect(folds(host)).toHaveLength(1);
    expect(foldButton(host).getAttribute('aria-expanded')).toBe('true');
    expect(seqs(host)).toEqual([1, 2, 3, 4, 5]);
    expect(detailOf(host, 4)).not.toBeNull();
  });

  it('the row the keyboard is on keeps its focus when the third call arrives', async () => {
    BLOCKS = CONVERSATION.slice(0, 4);
    const host = await mountFeed();
    const stop = host.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="3"] button[data-feed-expander]`)!;
    await act(async () => {
      stop.focus();
    });
    await act(async () => {
      push!({ sessionId: 'live-1', block: call(5, 'Read', 'src/lib/feed.ts') });
    });
    expect(document.activeElement).toBe(stop);
    expect(stop.isConnected).toBe(true);
  });

  it('…and calls nobody touched still fold shut', async () => {
    BLOCKS = CONVERSATION.slice(0, 4);
    const host = await mountFeed();
    // a click on PROSE is not a touch on a call
    await click(host.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="2"]`)!);
    await act(async () => {
      push!({ sessionId: 'live-1', block: call(5, 'Read', 'src/lib/feed.ts') });
    });
    expect(foldButton(host).getAttribute('aria-expanded')).toBe('false');
    expect(seqs(host)).toEqual([1, 2]);
  });
});

// The engine skips whole groups of 40 seqs and never the LAST one. A shut fold
// at the tail keeps only its head — which can be in an earlier group than the
// calls it stands for.
describe('a fold across a group boundary (#1130)', () => {
  it('the group holding a shut tail fold is the open one, and no group is empty', async () => {
    BLOCKS = [
      { seq: 30, kind: 'user', text: 'go', sidechain: false },
      ...[37, 38, 39, 40, 41, 42].map((seq) => call(seq, 'Grep', `t${seq}`)),
    ];
    const host = await mountFeed();
    const groups = [...host.querySelectorAll<HTMLElement>('[data-feed-group]')];
    // seqs 40-42 would have opened a second group; shut, they are not rendered
    expect(groups).toHaveLength(1);
    expect(groups[0].hasAttribute('data-feed-group-open')).toBe(true);
    expect(groups[0].querySelector('[data-feed-fold]')).not.toBeNull();

    await click(foldButton(host));
    const opened = [...host.querySelectorAll<HTMLElement>('[data-feed-group]')];
    expect(opened).toHaveLength(2);
    expect(opened.map((g) => g.hasAttribute('data-feed-group-open'))).toEqual([false, true]);
    for (const g of opened) expect(g.children.length).toBeGreaterThan(0);
    expect(seqs(host)).toEqual([30, 37, 38, 39, 40, 41, 42]);
  });
});

describe('a subagent’s burst (#1130)', () => {
  it('folds on the subagent’s own spine, under its caption', async () => {
    const sub = { sidechain: true, agentId: 'aaaaaa11', agentName: 'digger' };
    BLOCKS = [
      { seq: 1, kind: 'user', text: 'go', sidechain: false },
      call(2, 'Grep', 'a', sub),
      call(3, 'Read', 'b', sub),
      call(4, 'Read', 'c', sub),
      { seq: 5, kind: 'assistant', text: 'done', sidechain: false },
    ];
    const host = await mountFeed();
    expect(folds(host)).toHaveLength(1);
    const row = folds(host)[0];
    expect(row.style.marginInlineStart).toBe('var(--feed-sidechain-indent)');
    // the caption that says who is speaking is directly above the row
    expect(row.previousElementSibling?.className).toBe('agent-divider');
  });
});
