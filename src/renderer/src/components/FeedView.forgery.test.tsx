// @vitest-environment jsdom
// A reply cannot speak the feed's DOM protocol (#465).
//
// THE AUDIT, AND ITS VERDICT ON EXPLOITABILITY. #465 was filed as "same bug
// shape as #410, other surface — audit first, it may be benign-but-fragile".
// It was not benign. The feed's protocol is three attributes, and all three
// reached three live handlers off assistant-authored markdown (measured against
// the real pipeline on 2026-08-13, before the fix: `renderMarkdown` returned
// `data-feed-expander`, `data-feed-seq`, `data-no-toggle`, `tabindex`, `role`,
// `id` and `class` intact — DOMPurify keeps `data-*` by default):
//
//  1. ARROW-KEY NAVIGATION WEDGES. `FeedView` reads `[data-feed-expander]` off
//     the DOM at every keystroke and focuses `els[index]`. A forged `<span>` is
//     not focusable, so `focus()` is a no-op, `els.indexOf(activeElement)` never
//     advances past it, and every subsequent ArrowDown recomputes the same
//     index: the conversation's keyboard navigation is dead from that message
//     down, for the rest of the session.
//  2. …OR IS CAPTURED. A forged `<button>` or `<a href>` survives the sanitizer
//     intact and IS focusable, so instead the walk stops on a control the reply
//     planted, wearing a label it chose ("▾ OUT"). On an `<a href>` the Enter a
//     keyboard user then presses is a navigation. DOMPurify still refuses
//     `javascript:` and `on*`, so this is UI redress on the keyboard path, not
//     script execution — bounded, not benign.
//  3. FIND JUMPS TO THE WRONG PLACE. The jump resolves its target with
//     `querySelector('[data-feed-seq="N"]')`, which answers with the FIRST match
//     in document order. A reply carrying `data-feed-seq="4"` above block 4
//     takes every jump to block 4, so "find, then go to the hit" lands the user
//     on the attacker's paragraph and highlights it as the match.
//  4. `data-no-toggle` deadens a tool box's click-to-expand. Inert TODAY only
//     because no markdown renders inside a `ToolBox` — one renderer away, and
//     nothing was stopping it.
//
// And the clipboard shape #410 fixed on the viewer is one item away here: #477
// puts a copy button on the feed's code fences, which is exactly the
// `.doc-code`-wrapper-around-a-hidden-`<pre>` attack with the names changed.
//
// WHAT THIS FILE PINS is the end-to-end claim, through the panel contribution,
// the real registry, the real block renderers and the real handlers: the same
// pattern `FeedView.find.test.tsx` established, and for its reason — a test
// that reached for `decorateFeedMarkdown` directly would stay green with the
// feed's `decorate` prop cut.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import type { PanelContext } from '../extensibility/contributions';
import type { FeedBlockDto } from '../lib/feed';
import { resetFindSurfaces } from '../lib/find-surfaces';
import { FEED_EXPANDER_ATTR } from '../lib/feed-keys';
import { FEED_SEQ_ATTR } from '../lib/feed-reveal';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

/**
 * Assistant prose carrying real forged markup — every attribute below is read
 * by a handler named in the audit above, and this is markdown as it arrives:
 * raw embedded HTML in a reply, which `marked` passes through untouched.
 */
const FORGED = [
  'Here is the fix.',
  '',
  '<button data-feed-expander aria-expanded="false" data-no-toggle>▾ OUT</button>',
  '<span data-feed-seq="4">not the block you searched for</span>',
  '<a href="https://exfil.test/leak" data-feed-expander>Open the log</a>',
  '<span class="feed-md keep-me">borrowed styling</span>',
].join('\n');

/** the same message with the markup removed — the baseline the counts come from */
const HONEST = [
  'Here is the fix.',
  '',
  '▾ OUT not the block you searched for Open the log borrowed styling',
].join('\n');

function blocks(prose: string): FeedBlockDto[] {
  return [
    { seq: 1, kind: 'user', text: 'run the build', sidechain: false },
    {
      // three real expanders: the coarse header, IN and OUT
      seq: 2,
      kind: 'tool',
      tool: { name: 'Bash', category: 'shell', summary: 'npm run build', out: 'ok' },
      sidechain: false,
    },
    { seq: 3, kind: 'assistant', text: prose, sidechain: false },
    // the block the forged `data-feed-seq` claims to be — it must sit AFTER the
    // forgery, because first-in-document-order is the whole trick
    { seq: 4, kind: 'assistant', text: 'the build failed', sidechain: false },
  ];
}

function stubBridge(bs: FeedBlockDto[]): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve(bs),
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

/** mount the Session panel over `prose` and hand back its conversation region */
async function mountFeed(prose: string): Promise<HTMLElement> {
  stubBridge(blocks(prose));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(feedPanel.render(ctx()));
  });
  await act(async () => {
    await Promise.resolve(); // the backlog arrives on a promise
  });
  const region = host.querySelector<HTMLElement>('[data-feed-region]');
  if (!region) throw new Error('no feed region rendered');
  return region;
}

const expanders = (region: HTMLElement): HTMLElement[] =>
  Array.from(region.querySelectorAll<HTMLElement>(`[${FEED_EXPANDER_ATTR}]`));

/** the rendered prose of the block under test — `<Markdown>`'s own container */
function prose(region: HTMLElement): HTMLElement {
  const el = region.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="3"] .feed-md`);
  if (!el) throw new Error('the feed rendered no markdown for the assistant block');
  return el;
}

/** a real keystroke on the region, through FeedView's own handler */
async function key(region: HTMLElement, k: string): Promise<void> {
  await act(async () => {
    region.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

beforeAll(() => registerBuiltinContributions(rendererRegistry));

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  resetFindSurfaces();
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

describe('a reply cannot forge the feed’s expander protocol (#465)', () => {
  it('adds no stop to the conversation’s arrow-key list', async () => {
    const hostile = expanders(await mountFeed(FORGED)).length;
    const honest = expanders(await mountFeed(HONEST)).length;
    // non-vacuous: the bash block really did render its three, so "equal" is a
    // statement about the forgery and not about an empty feed
    expect(honest).toBe(3);
    expect(hostile).toBe(honest);
  });

  it('cannot plant a focusable control on the keyboard path', async () => {
    const region = await mountFeed(FORGED);
    const body = prose(region);
    // Walk the whole list and past its end, the way a reader does. Every stop
    // must be one of the feed's own buttons; none may be inside the reply.
    await act(async () => region.focus());
    for (let i = 0; i < 6; i++) {
      await key(region, 'ArrowDown');
      const active = document.activeElement as HTMLElement | null;
      expect(body.contains(active)).toBe(false);
      if (active && active !== region && active !== document.body) {
        expect(active.tagName).toBe('BUTTON');
        expect(active.hasAttribute(FEED_EXPANDER_ATTR)).toBe(true);
      }
    }
    // and the walk REACHED the end rather than wedging on a phantom: the last
    // stop is the feed's last real expander
    expect(document.activeElement).toBe(expanders(region).at(-1));
  });

  it('cannot capture a find jump by claiming another block’s seq', async () => {
    const region = await mountFeed(FORGED);
    // the exact expression FeedView's jump uses to resolve its target
    const target = region.querySelector<HTMLElement>(`[${FEED_SEQ_ATTR}="4"]`);
    expect(target).not.toBeNull();
    expect(target!.textContent).toContain('the build failed');
    expect(region.querySelectorAll(`[${FEED_SEQ_ATTR}="4"]`)).toHaveLength(1);
  });

  it('cannot deaden a tool box by forging the stand-down mark', async () => {
    const region = await mountFeed(FORGED);
    expect(prose(region).querySelector('[data-no-toggle]')).toBeNull();
    // the feed's own are untouched — the guard runs on the reply, not on us
    expect(region.querySelector('[data-no-toggle]')).not.toBeNull();
  });

  it('runs the feed’s OWN take-back pass, not only the profile', async () => {
    // WHICH LAYER IS ON TRIAL, so a green run is not read as more than it is.
    // `SANITIZE_CONFIG`'s `ALLOW_DATA_ATTR: false` (#465, `markdown.test.tsx`)
    // removes every `data-*` before the feed sees it — so every assertion above
    // stays green even with the feed's `decorate` prop cut, and none of them is
    // what detects that. CLASS is the half no sanitizer flag filters by prefix,
    // and this row is the one that reds when the wiring goes.
    // Mutation-verified 2026-08-13: `decorate` removed from the markdown
    // contribution → this test alone fails.
    const body = prose(await mountFeed(FORGED));
    expect(body.querySelector('.feed-md')).toBeNull();
    // and it takes only its own: the reply's other class is not the feed's
    expect(body.querySelector('.keep-me')).not.toBeNull();
  });

  it('strips the attributes, not the message', async () => {
    // The reader still sees everything the reply said. A guard that blanked the
    // block would pass every assertion above and be a worse bug than the one it
    // fixed.
    const body = prose(await mountFeed(FORGED));
    expect(body.textContent).toContain('Here is the fix.');
    expect(body.textContent).toContain('▾ OUT');
    expect(body.textContent).toContain('not the block you searched for');
    expect(body.textContent).toContain('Open the log');
    expect(body.textContent).toContain('borrowed styling');
  });
});
