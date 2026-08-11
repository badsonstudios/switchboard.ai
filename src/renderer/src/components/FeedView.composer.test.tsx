// @vitest-environment jsdom
// P2-E10-08 (#406): the composer grows by RENDERED height, not by newlines.
//
// `composer-size.test.ts` pins the arithmetic. This file pins the WIRING — that
// the component measures the textarea at all — because the defect being fixed
// was never in any arithmetic: it was `rows={min(6, draft.split('\n').length)}`
// on the element, a rule that is perfectly correct about a quantity nobody
// cares about. A pure test of a helper the render site does not call would stay
// green through exactly the regression this exists to catch (the same lesson as
// `FeedView.handoff.test.tsx`), so it renders through the panel contribution
// and reads the height back off the DOM.
//
// jsdom does no layout, so the browser's half of the deal is stubbed: a
// `scrollHeight` that wraps text at a fixed column, which is precisely the
// signal the old rule was blind to. Every assertion below is about a DIFFERENCE
// between measured heights, so nothing here depends on jsdom's padding maths.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { COMPOSER_MAX_LINES, resolveLineHeight } from '../lib/composer-size';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** where the fake browser wraps a soft line — arbitrary, and never a '\n' */
const WRAP_COLUMN = 40;
/** the composer's own block padding (7px top + 7px bottom) */
const PADDING = 14;

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
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** the height the component wrote back, in px */
const heightOf = (box: HTMLTextAreaElement): number => Number.parseFloat(box.style.blockSize);

/** one rendered line, by the same rule the component resolves it with */
function lineHeight(box: HTMLTextAreaElement): number {
  const cs = window.getComputedStyle(box);
  return resolveLineHeight(cs.lineHeight, cs.fontSize);
}

/**
 * The browser's half: report the height of the text as RENDERED, wrapping long
 * lines at a fixed column. `scrollHeight` is a layout read jsdom always answers
 * 0 to, and 0 for every draft is exactly the world in which #406 looks fixed.
 */
function stubWrappingLayout(): void {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement): number {
      const rendered = this.value
        .split('\n')
        .reduce((n, hard) => n + Math.max(1, Math.ceil(hard.length / WRAP_COLUMN)), 0);
      return rendered * lineHeight(this) + PADDING;
    },
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  stubBridge();
  // jsdom has no ResizeObserver, and both the scroll anchor and the composer's
  // re-measure-on-narrower install one
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  stubWrappingLayout();
  await initI18nForTests();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  vi.unstubAllGlobals();
});

describe('the composer sizes itself by rendered height (issue 406)', () => {
  it('grows for a pasted paragraph that has no newlines in it at all', async () => {
    const box = await mountComposer();
    const empty = heightOf(box);
    await type(box, wrapsTo(8));
    // the whole defect: `split('\n').length` is 1 for this draft, so the old
    // rule left it a one-row slot with seven lines hidden
    expect(heightOf(box) - empty).toBeCloseTo(7 * lineHeight(box), 1);
    expect(box.style.overflowY).toBe('hidden'); // all eight visible, no scrolling
    // and the height is not coming from `rows` — that stays put at one
    expect(box.rows).toBe(1);
  });

  it('stops growing at twelve lines and scrolls inside itself past that', async () => {
    const box = await mountComposer();
    await type(box, wrapsTo(COMPOSER_MAX_LINES));
    const capped = heightOf(box);
    expect(box.style.overflowY).toBe('hidden');

    await type(box, wrapsTo(COMPOSER_MAX_LINES * 3));
    expect(heightOf(box)).toBeCloseTo(capped, 1); // not one pixel taller
    expect(box.style.overflowY).toBe('auto'); // the rest is reachable by scrolling
  });

  it('shrinks back down as the text is deleted', async () => {
    const box = await mountComposer();
    const empty = heightOf(box);
    await type(box, wrapsTo(20));
    expect(heightOf(box)).toBeGreaterThan(empty);
    await type(box, wrapsTo(3));
    expect(heightOf(box) - empty).toBeCloseTo(2 * lineHeight(box), 1);
    await type(box, '');
    expect(heightOf(box)).toBeCloseTo(empty, 1);
  });

  it('counts hard newlines too — they are rendered lines like any other', async () => {
    const box = await mountComposer();
    const empty = heightOf(box);
    await type(box, 'one\ntwo\nthree');
    expect(heightOf(box) - empty).toBeCloseTo(2 * lineHeight(box), 1);
  });
});
