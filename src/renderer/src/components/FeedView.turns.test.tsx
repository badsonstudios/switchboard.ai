// @vitest-environment jsdom
// The turn boundary in the conversation (#640).
//
// The owner's complaint was that the line above a user prompt is too quiet to
// navigate a long session by. The LOOK is settled in tokens.css and measured
// in four themes by tokens.drift.test.ts — a stylesheet is the only witness a
// CSS-styled divider has. What no stylesheet can say is WHERE the divider is
// put, and that half is what this file holds:
//
//  * one per turn boundary — a boundary that appears above tool output, or
//    twice above one prompt, is furniture rather than a landmark;
//  * never above the FIRST block, because the top of a conversation is not a
//    boundary between two of anything;
//  * it survives the verbosity presets, which drop whole blocks: `quiet` hides
//    everything between two prompts, and a divider keyed off the unfiltered
//    list would then rule off a prompt that is now adjacent to nothing.
//
// Rendered through the PANEL CONTRIBUTION for FeedView.a11y's reason: the
// thread from `PanelContext` is load-bearing, and a test that reached for the
// component directly would stay green with that thread cut.
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

/** three turns, with assistant prose and a tool box between them */
const BLOCKS: FeedBlockDto[] = [
  { seq: 1, kind: 'user', text: 'run the build', sidechain: false },
  { seq: 2, kind: 'assistant', text: 'on it', sidechain: false },
  {
    seq: 3,
    kind: 'tool',
    tool: { name: 'Bash', category: 'shell', summary: 'npm run build', out: 'ok' },
    sidechain: false,
  },
  { seq: 4, kind: 'user', text: 'now the tests', sidechain: false },
  { seq: 5, kind: 'assistant', text: 'running them', sidechain: false },
  { seq: 6, kind: 'user', text: 'and ship it', sidechain: false },
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

/** every rendered block, in document order, as its `data-feed-block` kind */
function kinds(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-feed-block]')].map(
    (el) => el.dataset.feedBlock ?? '?'
  );
}

/**
 * The kind each divider is followed by — the only assertion that can tell a
 * divider in the right place from a divider that merely exists. A count alone
 * would pass with all three stacked above the last prompt.
 */
function precedes(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('.turn-divider')].map((el) => {
    const next = el.nextElementSibling as HTMLElement | null;
    return next?.dataset.feedBlock ?? '<nothing>';
  });
}

// the block RENDERERS are contributions: without them the feed renders empty
// boxes and every assertion here would be about markup with nothing in it
beforeAll(() => registerBuiltinContributions(rendererRegistry));

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  stubBridge();
  // jsdom has no ResizeObserver and the scroll-anchoring effect installs one
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

describe('the turn boundary (#640)', () => {
  it('rules off every prompt but the first, and nothing else', async () => {
    const host = await mountFeed();
    // the fixture is only worth asserting on if it really rendered three turns
    expect(kinds(host).filter((k) => k === 'user')).toHaveLength(3);
    // two boundaries for three turns, each one immediately above a prompt
    expect(precedes(host)).toEqual(['user', 'user']);
  });

  it('carries the words that make it scannable, and hides them from a reader', async () => {
    const host = await mountFeed();
    const divider = host.querySelector<HTMLElement>('.turn-divider')!;
    // the caption is i18n, never a literal — an empty divider is the hairline
    // #640 replaced, wearing the new class
    expect(divider.textContent?.trim()).toBe('New prompt');
    // ...and it is furniture for the eye: the prompt below is already
    // announced as the user's own words
    expect(divider.getAttribute('aria-hidden')).toBe('true');
  });

  it('follows the FILTERED conversation, not the raw one', async () => {
    // `quiet` drops the tool box, so turn one becomes prompt + prose. The
    // boundaries must still be the two prompts and not, say, the block that
    // used to be at index 3.
    const host = await mountFeed();
    const quiet = [...host.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.textContent === 'quiet'
    )!;
    await act(async () => quiet.click());
    expect(kinds(host)).not.toContain('tool');
    expect(precedes(host)).toEqual(['user', 'user']);
  });
});
