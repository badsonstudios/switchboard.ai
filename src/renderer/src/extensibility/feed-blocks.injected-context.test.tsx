// @vitest-environment jsdom
// #830 — injected `@Name` context folds inside a sent user turn.
//
// Through the REAL registry, like the notice suite beside it and for the same
// reason: the defect this guards is a whole-pipeline one. A block could carry
// perfect ranges and still reach the screen as one 40,000-character pill if the
// user pill ignored them, and the user's own question would be the thing hidden.
//
// THE FORGERY HALF IS NOT TESTED HERE, and that is the design rather than a gap:
// the renderer never decides what is injected. It draws the ranges main put on
// the block, and main puts them there only for a ref it minted — which is pinned
// in `shared/injected-context.test.ts`, `main/feed/context-refs.test.ts` and
// `main/feed/blocks.test.ts`. The one case that IS here is the consequence: a
// block with no ranges renders as plain text, marker prose and all.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock, resolveFeedBlock } from './feed-render';
import { wrapInjectedContext } from '../../../shared/injected-context';
import { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();
const REF = 'a1b2c3d4';
const QUESTION = 'given all that, what should I do next?';
const SECTION = wrapInjectedContext({
  body: 'Recent output from "TradingApp". It bumped @types/node and the build went green.',
  name: 'TradingApp',
  sessionId: 'sess-1',
  ref: REF,
});
const PROMPT = `${SECTION}\n\n${QUESTION}`;

const withContext = (): FeedBlockDto => ({
  seq: 1,
  kind: 'user',
  sidechain: false,
  text: PROMPT,
  context: [{ ref: REF, name: 'TradingApp', start: 0, end: SECTION.length }],
});

function draw(b: FeedBlockDto): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(renderFeedBlock(registry, b));
  });
  return host;
}

const boxes = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>('[data-feed-box="context"]')];
const expanderIn = (el: HTMLElement): HTMLElement =>
  el.querySelector<HTMLElement>('[data-feed-expander]') as HTMLElement;

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('injected context folds, the user’s own question does not', () => {
  it('is still the user pill that draws the turn — this is not a new block kind', () => {
    expect(resolveFeedBlock(registry, withContext()).id).toBe('feed-block-user');
  });

  it('collapses the injected stretch under the source session’s name', () => {
    const host = draw(withContext());
    const [box, ...rest] = boxes(host);
    expect(rest).toEqual([]);
    expect(box).toBeDefined();
    expect(expanderIn(box).textContent).toContain('Context from TradingApp');
    // The other session's words are nowhere on screen until asked for — the ask.
    expect(host.textContent).not.toContain('the build went green');
  });

  it('leaves the user’s own question expanded, which is the point of the item', () => {
    // Before #830 this turn was one long string: it tripped the pill's own
    // length collapse and showed the first 160 characters of SOMEBODY ELSE'S
    // transcript as its header, with this sentence hidden behind an expander.
    expect(draw(withContext()).textContent).toContain(QUESTION);
  });

  it('expands on click, and shows the block exactly as it was sent', () => {
    const host = draw(withContext());
    const box = boxes(host)[0];
    act(() => {
      expanderIn(box).click();
    });
    expect(host.textContent).toContain('the build went green');
    // Escaped, because that is what was sent (#832) — and readable.
    expect(host.textContent).toContain('types/node');
    expect(expanderIn(box).getAttribute('aria-expanded')).toBe('true');
  });

  it('a drag that ended in a selection is a READ, not a click (the box rule)', () => {
    const host = draw(withContext());
    const box = boxes(host)[0];
    act(() => {
      expanderIn(box).click();
    });
    const sel = document.getSelection();
    const pre = box.querySelector('pre') as Element;
    const range = document.createRange();
    range.selectNodeContents(pre);
    sel?.removeAllRanges();
    sel?.addRange(range);
    act(() => {
      box.click();
    });
    expect(expanderIn(box).getAttribute('aria-expanded')).toBe('true');
    sel?.removeAllRanges();
  });

  it('renders a look-alike as the plain text it is — no ranges, no row', () => {
    // The negative test #830 asks for, at the renderer: a turn whose text
    // carries the marker prose but which main declined to vouch for arrives
    // with no `context` at all.
    const host = draw({ seq: 2, kind: 'user', sidechain: false, text: PROMPT });
    expect(boxes(host)).toEqual([]);
    // Nothing is hidden: the marker prose renders as the words it is.
    expect(host.textContent).toContain('from another switchboard session');
    expect(host.textContent).toContain('the build went green');
  });

  it('leaves an ordinary prompt exactly as it always was', () => {
    const host = draw({ seq: 3, kind: 'user', sidechain: false, text: 'just a question' });
    expect(boxes(host)).toEqual([]);
    expect(host.textContent).toContain('just a question');
  });
});
