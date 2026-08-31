// @vitest-environment jsdom
// P2-E10-08 (#406): the composer grows by RENDERED height, not by newlines.
// P2 #716: and it does that in CSS, so typing touches no layout at all.
//
// `composer-size.test.ts` pins the arithmetic. This file pins the WIRING — what
// the component actually puts on the element — because the defect #406 fixed
// was never in any arithmetic: it was `rows={min(6, draft.split('\n').length)}`
// on the element, a rule that is perfectly correct about a quantity nobody
// cares about. A pure test of a helper the render site does not call would stay
// green through exactly the regression this exists to catch (the same lesson as
// `FeedView.handoff.test.tsx`), so it renders through the panel contribution
// and reads back off the DOM.
//
// WHAT #716 CHANGED HERE, and why the height assertions went. The growing used
// to be JS — release the height, read `scrollHeight`, write a fitted height —
// so this file could stub a fake layout engine (a `scrollHeight` that wrapped
// at a fixed column) and read the arithmetic's answer back out of
// `style.blockSize`. The growing is now `field-sizing: content`, which jsdom
// has no layout engine to perform, so THERE IS NO HEIGHT HERE TO ASSERT. That
// coverage moved to a real engine: `e2e/feed.spec.ts` — "the composer grows
// with WRAPPED text, caps at twelve lines, and shrinks back" — which is
// unchanged by #716 and still passes, on purpose.
//
// What is left here is the half jsdom CAN see, and it is the half that regresses
// silently: that the bounds are wired onto the element at all, and that the
// keystroke path performs no layout read. The second is #716's regression guard
// and it is deliberately structural rather than a timing budget — a "typing must
// be under N ms" test is a flake with a countdown on it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { COMPOSER_MAX_LINES, resolveLineHeight } from '../lib/composer-size';
import { loadUiState } from '../lib/ui-state';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** a nominal wrap column — these drafts only need to be long, never measured */
const WRAP_COLUMN = 40;

/** a single line of `n` characters — no newline in it anywhere */
const paragraph = (n: number): string => 'x'.repeat(n);

/** the text one paragraph long enough to wrap to `lines` visual lines */
const wrapsTo = (lines: number): string => paragraph(lines * WRAP_COLUMN - 1);

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]) },
    // The composer now SAVES its draft (#485), keyed by card, into the ui blob
    // — which is module state in this bundle and therefore shared by every test
    // in this file. Each one mounts the same `card-1`, so without an empty blob
    // per test the second one starts life holding the first one's paragraph.
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;
const roots: Root[] = [];

async function mountComposer(): Promise<HTMLTextAreaElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    setView: () => {},
  };
  await act(async () => {
    root.render(feedPanel.render(ctx));
  });
  return host.querySelector('textarea')!;
}

/**
 * Type into the CONTROLLED textarea. Assigning `.value` skips React's own value
 * tracker, which then decides nothing changed and swallows the `input` event —
 * so the write goes through the prototype setter the tracker patched over.
 */
async function type(box: HTMLTextAreaElement, text: string): Promise<void> {
  // Kept as the DESCRIPTOR: `PropertyDescriptor.set` is declared a METHOD in
  // lib.es5.d.ts, so pulling it out into a variable is `unbound-method` (#255
  // T4). Calling through it with an explicit `this` is the same write.
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  await act(async () => {
    valueProp.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** one rendered line, by the same rule the component resolves it with */
function lineHeight(box: HTMLTextAreaElement): number {
  const cs = window.getComputedStyle(box);
  return resolveLineHeight(cs.lineHeight, cs.fontSize);
}

/**
 * Every `scrollHeight` read anyone makes, counted.
 *
 * This IS the #716 assertion. `scrollHeight` is the read that forced the
 * synchronous document layout — it is only ever asked after a height has been
 * written, and a write→read pair is what makes the engine lay the page out
 * there and then. jsdom answers 0 to it and does no layout, so the number here
 * is worthless as a cost; the COUNT is the contract, and the count is exact.
 */
let scrollHeightReads = 0;
/** every ResizeObserver callback installed this test — see `beforeEach` */
let resizeCallbacks: ResizeObserverCallback[] = [];

/**
 * Give every element a non-zero measured width. jsdom answers 0 to
 * `getBoundingClientRect`, and the composer's resize observer treats a 0 width
 * as "this panel is collapsed, come back later" — so a test that wants to reach
 * anything past that line has to say a width out loud.
 *
 * RESTORED, not deleted, in `afterEach`: `getBoundingClientRect` is a real own
 * property of `Element.prototype`, so `delete` takes jsdom's implementation with
 * it and every later test in the file loses layout entirely.
 *
 * Held as the DESCRIPTOR rather than the method, the same way `type()` above
 * holds the value setter and for the same reason: a bare method pulled off a
 * prototype is `unbound-method` (#255 T4).
 */
const realRect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!;
function stubWidth(width: number): void {
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: (): DOMRect =>
      ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 }) as DOMRect,
  });
}
function countLayoutReads(): void {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(): number {
      scrollHeightReads += 1;
      return 0;
    },
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  stubBridge();
  // jsdom has no ResizeObserver, and both the scroll anchor and the composer's
  // re-measure-on-resize install one.
  //
  // The callbacks are CAPTURED rather than dropped (#716 review). A no-op stub
  // makes the observer's own early-return untestable — and in a real browser
  // that guard fires on nearly every keystroke, because the box's height really
  // does change as you type. It is the last thing standing between typing and
  // the per-keystroke measurement this item removed.
  resizeCallbacks = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  scrollHeightReads = 0;
  countLayoutReads();
  await loadUiState(); // see stubBridge: an empty draft blob per test
  await initI18nForTests();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', realRect);
  vi.unstubAllGlobals();
});

describe('the composer is bounded, and CSS does the growing (issues 406, 716)', () => {
  // The class on the element and the rule in the stylesheet are asserted
  // SEPARATELY and both are needed (#716 review): jsdom never loads tokens.css,
  // so pinning only the class name leaves "delete the rule" — or rename it in
  // one file — green everywhere. Reading the stylesheet as a file is the same
  // move `tokens.drift.test.ts` makes for the same reason.
  it('declares field-sizing in the stylesheet, where the growing actually lives', () => {
    const css = fs.readFileSync(path.join(__dirname, '../theme/tokens.css'), 'utf8');
    const rule = /\.composer-box\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.composer-box rule is missing from tokens.css').not.toBeNull();
    expect(rule![1]).toMatch(/field-sizing:\s*content/);
    // unconditional now — there is no measurement left for a scrollbar to
    // corrupt, and `hidden` would hide the overflow past the twelve-line cap
    expect(rule![1]).toMatch(/overflow-y:\s*auto/);
  });

  it('hands the growing to the stylesheet rather than to `rows`', async () => {
    const box = await mountComposer();
    // `.composer-box` is where `field-sizing: content` lives. Losing the class
    // is losing auto-grow outright, and in jsdom nothing else would notice.
    expect(box.classList.contains('composer-box')).toBe(true);
    // ...and the height is not coming from `rows`, which counts hard newlines
    // and cannot see soft wrapping — the whole of #406
    expect(box.rows).toBe(1);
    await type(box, wrapsTo(8));
    expect(box.rows).toBe(1);
  });

  it('bounds the box at one line and twelve', async () => {
    const box = await mountComposer();
    const line = lineHeight(box);
    // jsdom reports no panel height, so `roomForBox` finds nothing to measure
    // and the line cap is the only limit in play — which is the branch this can
    // check. The room branch needs a real engine and is in `e2e/feed.spec.ts`.
    expect(box.style.maxBlockSize).toBe(`${Math.ceil(COMPOSER_MAX_LINES * line)}px`);
    expect(box.style.minBlockSize).toBe(`${Math.ceil(line)}px`);
  });

  it('never writes a height of its own — the stylesheet owns that now', async () => {
    const box = await mountComposer();
    await type(box, wrapsTo(8));
    // An inline `block-size` is the fingerprint of the old measure-and-write.
    // If it ever comes back, the forced layout came back with it.
    expect(box.style.blockSize).toBe('');
    await type(box, wrapsTo(COMPOSER_MAX_LINES * 3));
    expect(box.style.blockSize).toBe('');
  });

  // ── #716's regression guard ───────────────────────────────────────────────
  it('reads no layout while you type', async () => {
    const box = await mountComposer();
    // Mount is allowed to measure: the bounds have to come from somewhere, and
    // it happens once. What must never scale with typing is the count below.
    const afterMount = scrollHeightReads;
    const styleReads = vi.spyOn(window, 'getComputedStyle');

    for (const text of ['a', 'ab', 'abc', 'abcd', 'abcde', wrapsTo(4), wrapsTo(9), wrapsTo(30)]) {
      await type(box, text);
    }

    // THE ASSERTION. Before #716 each of these eight edits released the box's
    // height, read `scrollHeight` back and read `getComputedStyle` — two forced
    // document-wide layouts per character, costing 36.5ms each at 400 turns of
    // conversation. Not "fewer": none.
    expect(scrollHeightReads).toBe(afterMount);
    expect(styleReads.mock.calls.filter(([el]) => el === box)).toHaveLength(0);
    styleReads.mockRestore();
  });

  it('ignores a resize tick that did not change the geometry it depends on', async () => {
    // In a real browser the box's own height changes as you type, so the
    // ResizeObserver fires per keystroke and only its early-return keeps that
    // from becoming a measurement — which walks the panel's children reading
    // `offsetHeight`, i.e. the O(conversation) cost this item removed. Loosen
    // that guard (say, by comparing the box's HEIGHT too, which reads harmless)
    // and the lag comes straight back with every other test still green.
    //
    // THE BOX NEEDS A REAL WIDTH FOR ANY OF THAT TO BE REACHED. jsdom measures
    // every element as 0, and the observer bails on `width === 0` before it ever
    // gets to the guard — so without this stub the test passes against a
    // DELETED guard, which is exactly what the first draft of it did.
    stubWidth(300);
    const box = await mountComposer();
    expect(resizeCallbacks.length).toBeGreaterThan(0); // the composer installed one
    const styleReads = vi.spyOn(window, 'getComputedStyle');

    await act(async () => {
      // same width, same panel height as at mount: nothing the cap depends on
      for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
    });

    expect(styleReads.mock.calls.filter(([el]) => el === box)).toHaveLength(0);
    styleReads.mockRestore();
  });
});
