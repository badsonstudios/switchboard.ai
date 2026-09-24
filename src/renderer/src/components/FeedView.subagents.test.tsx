// @vitest-environment jsdom
// Which subagent is speaking (#788).
//
// `feed-groups.test.ts` pins the RULE — which block starts a run, what it is
// called, when a name needs a disambiguator. What no pure test can say is that
// the rule reaches the screen, and that is the half this file holds. #785's
// lesson, twice over now: a fix can revert silently in the renderer while every
// unit test stays green, and an i18n key can be wired to the wrong string with
// nothing to notice.
//
// Rendered through the PANEL CONTRIBUTION, like `FeedView.turns.test.tsx` and
// for the same reason: the thread from `PanelContext` is load-bearing and a
// test reaching for the component directly would stay green with it cut.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import type { PanelContext } from '../extensibility/contributions';
import type { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

/**
 * What the watcher really produces for two concurrent subagents: one main
 * prompt, then two agents' blocks INTERLEAVED in tail-arrival order, with the
 * second agent sharing the first's name (measured — one session ran three
 * overlapping `deep-research-specialist`s).
 */
const INTERLEAVED: FeedBlockDto[] = [
  { seq: 1, kind: 'user', text: 'research both', sidechain: false },
  // agent A opens unnamed, exactly as a subagent transcript's first `user`
  // line does
  { seq: 2, kind: 'user', text: 'task for A', sidechain: true, agentId: 'aaaaaa11' },
  {
    seq: 3,
    kind: 'assistant',
    text: 'B reporting',
    sidechain: true,
    agentId: 'bbbbbb22',
    agentName: 'deep-research-specialist',
  },
  {
    seq: 4,
    kind: 'assistant',
    text: 'A reporting',
    sidechain: true,
    agentId: 'aaaaaa11',
    agentName: 'deep-research-specialist',
  },
  { seq: 5, kind: 'assistant', text: 'both are in', sidechain: false },
];

let BLOCKS: FeedBlockDto[] = INTERLEAVED;

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

/** every caption, in document order */
function captions(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('.agent-divider')].map(
    (el) => el.textContent?.trim() ?? ''
  );
}

/**
 * The `seq` each caption sits above. A count alone cannot tell a caption in the
 * right place from one that merely exists — all three stacked at the top would
 * pass a count.
 *
 * Matched on `data-feed-seq` rather than on the block's text: a tool row
 * renders its name, its expander glyph and its argument all inside the same
 * element, so a text match there asserts the tool renderer's markup as a side
 * effect and goes red when that markup changes for unrelated reasons.
 */
function precedes(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('.agent-divider')].map((el) => {
    const next = el.nextElementSibling as HTMLElement | null;
    return next?.getAttribute('data-feed-seq') ?? '<nothing>';
  });
}

beforeAll(() => registerBuiltinContributions(rendererRegistry));

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  BLOCKS = INTERLEAVED;
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

describe('the caption sits on the spine it captions', () => {
  // A SOURCE scan, not a DOM one, and deliberately: jsdom does not resolve
  // custom properties, so a `getComputedStyle` here reads the literal
  // `var(--feed-sidechain-indent)` back and would pass just as happily against
  // two hand-written `14px`s that had drifted apart. A mutation round found
  // exactly that hole — the block's indent could be changed back to a bare
  // `14` with every rendering test still green.
  //
  // What is checkable is that both sides name the SAME token, which is the
  // claim the token was introduced to make.
  const src = (p: string): string => fs.readFileSync(path.join(__dirname, p), 'utf8');

  it('the block indent and the caption indent name one token', () => {
    const view = src('FeedView.tsx');
    const css = src('../theme/tokens.css');
    expect(view).toContain("marginInlineStart: 'var(--feed-sidechain-indent)'");
    expect(css).toMatch(/\.agent-divider\s*\{[^}]*margin-inline-start:\s*var\(--feed-sidechain-indent\)/);
    // and the token is actually declared, rather than resolving to nothing
    expect(css).toMatch(/--feed-sidechain-indent:\s*\d/);
  });
});

describe('subagent run captions (#788)', () => {
  it('opens each run, and separates two agents sharing one name', async () => {
    const host = await mountFeed();
    // three runs: A, then B, then A again
    expect(precedes(host)).toEqual(['2', '3', '4']);
    // ...each named, and each carrying the id fragment that tells the two
    // identically-named agents apart. Without the fragment all three read
    // `Subagent · deep-research-specialist` and the separation is invisible.
    expect(captions(host)).toEqual([
      'Subagent · deep-research-specialist · aaaaaa',
      'Subagent · deep-research-specialist · bbbbbb',
      'Subagent · deep-research-specialist · aaaaaa',
    ]);
  });

  it('names a run whose own first block is anonymous', async () => {
    // Block 2 carries no `agentName` — the name is on block 4, a different run
    // of the same agent. Captioning from the head block would render the first
    // run as a bare `Subagent` under the same agent's named caption.
    const host = await mountFeed();
    expect(captions(host)[0]).toContain('deep-research-specialist');
  });

  it('puts NO caption above the main conversation', async () => {
    const host = await mountFeed();
    expect(precedes(host)).not.toContain('1'); // the human's prompt
    expect(precedes(host)).not.toContain('5'); // the session's own reply
  });

  it('is announced, unlike the turn divider', async () => {
    // The deliberate difference. A screen reader is told "new prompt" by the
    // prompt itself, so that divider is hidden — but nothing else in the app
    // ever says which agent is speaking, so hiding this one would hand a
    // screen-reader user the exact bug this item fixes.
    const host = await mountFeed();
    const caption = host.querySelector<HTMLElement>('.agent-divider')!;
    expect(caption.getAttribute('aria-hidden')).toBeNull();
  });

  it('drops the id fragment when one name is unambiguous', async () => {
    BLOCKS = [
      { seq: 1, kind: 'assistant', text: 'A', sidechain: true, agentId: 'aaaaaa11', agentName: 'Explore' },
      { seq: 2, kind: 'assistant', text: 'B', sidechain: true, agentId: 'bbbbbb22', agentName: 'Plan' },
    ];
    const host = await mountFeed();
    expect(captions(host)).toEqual(['Subagent · Explore', 'Subagent · Plan']);
  });

  it('falls back to a bare caption for a transcript with no names', async () => {
    // Pre-2.1.226: an id to group on, nothing to call it.
    BLOCKS = [
      { seq: 1, kind: 'assistant', text: 'old', sidechain: true, agentId: 'old1' },
    ];
    const host = await mountFeed();
    expect(captions(host)).toEqual(['Subagent']);
  });

  it('still captions a sidechain with NO id at all', async () => {
    // A resumed stream session replays the main transcript only, so it has no
    // subagent filename to fall back on and these blocks can never be
    // attributed. Before #788 they at least got a stray "NEW PROMPT" rule;
    // removing that without putting anything in its place would leave them
    // with less separation than the bug being fixed.
    BLOCKS = [
      { seq: 1, kind: 'assistant', text: 'mine', sidechain: false },
      { seq: 2, kind: 'user', text: 'a task', sidechain: true },
      { seq: 3, kind: 'assistant', text: 'a reply', sidechain: true },
    ];
    const host = await mountFeed();
    // one caption for the whole unattributed run, above its first block
    expect(captions(host)).toEqual(['Subagent']);
    expect(precedes(host)).toEqual(['2']);
    // ...and the turn divider is still correctly absent from the agent's prompt
    expect(host.querySelectorAll('.turn-divider')).toHaveLength(0);
  });

  it('separates two ANONYMOUS runs, which have no other cue', async () => {
    BLOCKS = [
      { seq: 1, kind: 'assistant', text: 'x', sidechain: true, agentId: 'aaaaaa11' },
      { seq: 2, kind: 'assistant', text: 'y', sidechain: true, agentId: 'bbbbbb22' },
    ];
    const host = await mountFeed();
    expect(captions(host)).toEqual(['Subagent · aaaaaa', 'Subagent · bbbbbb']);
  });

  it('captions nothing at all when no block is attributed', async () => {
    // Every session that never spawns a subagent. The furniture must not
    // appear, or this feature is a tax on the common case.
    BLOCKS = [
      { seq: 1, kind: 'user', text: 'hi', sidechain: false },
      { seq: 2, kind: 'assistant', text: 'hello', sidechain: false },
    ];
    const host = await mountFeed();
    expect(captions(host)).toEqual([]);
  });

  it('follows the FILTERED conversation', async () => {
    // `quiet` drops tool blocks. A run whose head was a tool block must be
    // captioned at the first block the user can actually still see, not lost.
    BLOCKS = [
      { seq: 1, kind: 'user', text: 'go', sidechain: false },
      {
        seq: 2,
        kind: 'tool',
        tool: { name: 'Bash', category: 'shell', summary: 'ls' },
        sidechain: true,
        agentId: 'aaaaaa11',
        agentName: 'Explore',
      },
      { seq: 3, kind: 'assistant', text: 'found it', sidechain: true, agentId: 'aaaaaa11' },
    ];
    const host = await mountFeed();
    expect(precedes(host)).toEqual(['2']); // the tool row, not the prose below it
    // `firehose` shows everything including sidechain prose; `quiet` hides
    // sidechain prose entirely, so switch to it and the run vanishes with it.
    const quiet = [...host.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.textContent === 'quiet'
    )!;
    await act(async () => quiet.click());
    expect(captions(host)).toEqual([]);
  });
});
