// @vitest-environment jsdom
// A feed block that throws WHILE REACT RENDERS IT costs that block, and
// nothing else (#594).
//
// `renderFeedBlock` has always try/caught the renderer CALL — the contribution
// building its node. That catches a different failure class from the one that
// actually white-screens the window: an element the renderer returned happily,
// which throws when React renders it. React is the caller there, so no
// try/catch in our code is on the stack, and there is no error boundary
// anywhere between a feed block and the renderer root — so one malformed block
// in one session's transcript blanks every session in the window, terminals
// included. Transcript blocks are untrusted input from another process; this is
// the P6 (fail-open) failure `ContributionBoundary` exists to prevent, on the
// surface its own docs list as a consumer.
//
// The mutation these tests stand on: remove the boundary from `Block` and the
// first case does not fail on an assertion, it throws out of `root.render` —
// which is the white-screen, reproduced.
//
// It renders through the PANEL CONTRIBUTION, following FeedView.find's lesson:
// the whole point is the real feed's real block path, and a test that mounted
// a bare `<Block>` would prove nothing about what a session actually shows.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import { CONTRIBUTION_RETRY_LIMIT } from '../extensibility/boundary';
import type { PanelContext } from '../extensibility/contributions';
import type { FeedBlockDto } from '../lib/feed';
import { FEED_SEQ_ATTR } from '../lib/feed-reveal';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

/** the seq the exploding contribution claims — nothing else touches it */
const BAD_SEQ = 2;
const BEFORE = 'the block before the bad one';
const AFTER = 'the block after the bad one';
/** what the exploding contribution renders once it stops exploding */
const HEALED = 'it works again';
/** the failed block's own text, which must never reach the page */
const BAD_TEXT = 'this one detonates';

const BLOCKS: FeedBlockDto[] = [
  { seq: 1, kind: 'assistant', text: BEFORE, sidechain: false },
  { seq: BAD_SEQ, kind: 'assistant', text: BAD_TEXT, sidechain: false },
  { seq: 3, kind: 'assistant', text: AFTER, sidechain: false },
];

/** flipped by a test to prove the block comes BACK, not just that it dies quietly */
let explode = true;
/** every render the exploding contribution's element was actually offered */
let attempts = 0;

function Exploder(): React.JSX.Element {
  attempts += 1;
  if (explode) throw new Error('feed block exploded during render');
  return <span>{HEALED}</span>;
}

const EXPLODING_ID = 'exploding-block';

/**
 * A renderer that BUILDS FINE and whose output throws — the exact shape
 * `renderFeedBlock`'s try/catch cannot see. `render` returns a fresh element
 * per call, like every built-in renderer does, which is also what the
 * boundary's retry keys on.
 */
const exploding = {
  manifest: {
    id: EXPLODING_ID,
    displayName: 'exploding block',
    version: '1.0.0',
    capabilities: ['feed.render'],
  },
  order: 0, // ahead of every built-in, so it wins the block
  matches: (b: FeedBlockDto) => b.seq === BAD_SEQ,
  render: () => <Exploder />,
};

/** the boundary's OWN log lines, separated from React's error noise */
function boundaryLogs(): string[] {
  const spy = console.error as unknown as ReturnType<typeof vi.fn>;
  return spy.mock.calls
    .map((c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''))
    .filter((m: string) => m.startsWith('[contributions]'));
}

/** how the feed hears about a new/updated block — the streamed-chunk path */
let push: ((p: { sessionId: string; block: FeedBlockDto }) => void) | null = null;

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve(BLOCKS),
      onBlock: (cb: (p: { sessionId: string; block: FeedBlockDto }) => void) => {
        push = cb;
        return () => {
          push = null;
        };
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

/** one streamed update, which is what re-renders the feed in production */
async function stream(seq: number, text: string): Promise<void> {
  await act(async () => {
    push?.({ sessionId: 'live-1', block: { seq, kind: 'assistant', text, sidechain: false } });
  });
}

beforeAll(() => {
  // the block renderers are contributions: without them the feed renders empty
  // boxes and "the rest of the feed survived" would pass vacuously
  registerBuiltinContributions(rendererRegistry);
  rendererRegistry.register('feed-block-renderer', exploding);
});

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  explode = true;
  attempts = 0;
  push = null;
  // React shouts about every caught error; the spy is also how the boundary's
  // own lines are counted
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
  vi.restoreAllMocks();
});

describe('a feed block whose renderer output throws (#594)', () => {
  it('leaves the rest of the feed alive instead of blanking the window', async () => {
    const host = await mountFeed();

    // the window is still standing — without the boundary this line is never
    // reached, because mounting threw
    expect(host.textContent).toContain(BEFORE);
    expect(host.textContent).toContain(AFTER);
    // and the thing that threw is a gap, not a placeholder shouting at the user
    expect(host.textContent).not.toContain(BAD_TEXT);
    expect(attempts).toBeGreaterThan(0); // it really was offered a render
  });

  it('keeps the failed block row, so a find jump still lands on it', async () => {
    // the boundary is INSIDE the row: the gutter, the dot and the seq anchor
    // are the feed's own markup and did not fail
    const host = await mountFeed();

    expect(host.querySelector(`[${FEED_SEQ_ATTR}="${BAD_SEQ}"]`)).not.toBeNull();
    expect(host.querySelector(`[${FEED_SEQ_ATTR}="1"]`)).not.toBeNull();
  });

  it('names the contribution that failed', async () => {
    await mountFeed();

    const logs = boundaryLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((m) => m.includes(`"${EXPLODING_ID}"`))).toBe(true);
  });

  it('comes back on the next streamed update, without the app restarting', async () => {
    // #463's retry has to actually REACH the feed: the boundary retries only
    // when its `children` identity changes, so this is the claim that a feed
    // re-render produces a new element for the block (it does — `render(b)`
    // builds a fresh one and `Block` is not memoised).
    const host = await mountFeed();
    expect(host.textContent).not.toContain(HEALED);

    explode = false;
    await stream(4, 'a later chunk');

    expect(host.textContent).toContain(HEALED);
    expect(host.textContent).toContain(BEFORE);
  });

  it('stops offering renders once the bound is spent, rather than throwing per chunk', async () => {
    // The other half of #463, and the one that matters most HERE: the feed
    // re-renders on every streamed chunk, so unbounded retry would turn one
    // deterministic bug into an exception per chunk for the life of the
    // session.
    const host = await mountFeed();
    for (let i = 0; i < CONTRIBUTION_RETRY_LIMIT; i++) await stream(10 + i, `chunk ${i}`);
    const spent = attempts;

    for (let i = 0; i < 10; i++) await stream(20 + i, `later chunk ${i}`);

    expect(attempts).toBe(spent);
    expect(boundaryLogs().filter((m) => m.includes('giving up'))).toHaveLength(1);
    // and the feed is still a feed
    expect(host.textContent).toContain(BEFORE);
    expect(host.textContent).toContain(AFTER);
  });
});
