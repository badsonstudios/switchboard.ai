// @vitest-environment jsdom
// The a11y contract of the feed's blocks (#174), as an executable claim.
//
// The feed had no keyboard path to any expander: every one of them was a div
// with an onClick. The fix is one shape — a real `<button aria-expanded>` on
// the block's header — and the thing most likely to rot is a NEW renderer
// wrapping in `ToolBox` and forgetting it. So this renders every shipped block
// shape through the real registry and asserts the contract off the DOM, rather
// than trusting each renderer to have remembered.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../i18n/locales/en.json';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock } from './feed-render';
import { FEED_EXPANDER_ATTR } from '../lib/feed-keys';
import { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

function block(over: Partial<FeedBlockDto>): FeedBlockDto {
  return { seq: 1, kind: 'assistant', sidechain: false, ...over } as FeedBlockDto;
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

function expanders(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>(`[${FEED_EXPANDER_ATTR}]`));
}

const bash = block({
  kind: 'tool',
  tool: { name: 'Bash', category: 'shell', summary: 'echo hi', description: 'Say hi', out: 'hi' },
});
const edit = block({
  kind: 'tool',
  tool: { name: 'Edit', summary: 'a.ts', filePath: 'a.ts', oldString: 'OLD', newString: 'NEW' },
});
const readTool = block({ kind: 'tool', tool: { name: 'Read', summary: 'a.md', detail: '{"file_path":"a.md"}' } });
const bareTool = block({ kind: 'tool', tool: { name: 'Read', summary: 'a.md' } });
const todos = block({ kind: 'todos', todos: [{ content: 'step one', status: 'completed' }] });
const thinking = block({ kind: 'thinking', text: 'pondering', durationMs: 3000 });
const command = block({ kind: 'user', text: '<command-name>/usage</command-name>\nboilerplate' });
const shortPrompt = block({ kind: 'user', text: 'do the thing' });

// #380: this file renders real components, several of which call
// `useTranslation`, and it used to render them with i18next never initialised
// — react-i18next warned `NO_I18NEXT_INSTANCE` once per run and every label
// came back as its own key. The names below are then only accidentally
// non-empty, which is most of what this file is checking. One line puts the
// app's own configuration under it.
beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('every expander in the feed is a real button', () => {
  const cases: Array<[string, FeedBlockDto, number]> = [
    // the coarse header + IN + OUT: the two inner ones are exactly what a
    // box-level control could never reach on its own
    ['bash', bash, 3],
    ['edit', edit, 1],
    ['tool row with detail', readTool, 1],
    ['thinking', thinking, 1],
    ['collapsed command prompt', command, 1],
    // nothing to expand -> nothing that claims it can
    ['tool row with no detail', bareTool, 0],
    ['todos checklist', todos, 0],
    ['short prompt', shortPrompt, 0],
  ];

  for (const [name, b, count] of cases) {
    it(`${name}: ${count} expander(s), each a <button> that states its state`, () => {
      const host = draw(b);
      const found = expanders(host);
      expect(found).toHaveLength(count);
      for (const el of found) {
        expect(el.tagName).toBe('BUTTON');
        expect(el.getAttribute('type')).toBe('button');
        expect(['true', 'false']).toContain(el.getAttribute('aria-expanded'));
        // reached by the arrow keys, not by Tab — see lib/feed-keys.ts
        expect(el.getAttribute('tabindex')).toBe('-1');
        // it sits inside ToolBox, whose body is also a mouse target; without
        // this the click toggles twice and cancels out
        expect(el.hasAttribute('data-no-toggle')).toBe(true);
        // an accessible name, or a screen reader announces "button" and nothing
        expect((el.textContent ?? '').trim().length).toBeGreaterThan(0);
      }
    });
  }
});

describe('the box tells the truth about what it is', () => {
  it('never claims a role it cannot have', () => {
    // A `role="button"` here is THE thing #174 was filed over: the bash box
    // CONTAINS the IN/OUT buttons, and a button may not contain buttons.
    for (const b of [bash, edit, readTool, todos]) {
      const host = draw(b);
      const box = host.querySelector('[data-feed-box]');
      expect(box).not.toBeNull();
      expect(box?.getAttribute('role')).toBeNull();
      expect(box?.hasAttribute('aria-expanded')).toBe(false);
    }
  });

  it('aria-controls always points at an element that exists', () => {
    // a dangling aria-controls is worse than none: it sends a screen reader
    // somewhere there is nothing
    for (const b of [bash, edit, readTool, thinking, command]) {
      const host = draw(b);
      for (const el of expanders(host)) {
        const controls = el.getAttribute('aria-controls');
        if (controls === null) continue;
        for (const id of controls.split(' ')) {
          expect(host.querySelector(`[id="${id}"]`), `${id} is not in the document`).not.toBeNull();
        }
      }
    }
  });
});

describe('operating an expander from the keyboard does what the mouse does', () => {
  it('a click on the header button expands that block, once', () => {
    // "once" is the trap: the button is inside a box that ALSO toggles on
    // click, so a missing data-no-toggle shows up here as a no-op
    const host = draw(readTool);
    const [header] = expanders(host);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('file_path');
  });

  it('the Bash IN and OUT expanders stay independent of the coarse one', () => {
    const host = draw(bash);
    const [coarse, inSection, outSection] = expanders(host);
    act(() => {
      outSection.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(outSection.getAttribute('aria-expanded')).toBe('true');
    expect(inSection.getAttribute('aria-expanded')).toBe('false');
    // the header reports the COARSE state — "something in here is open" —
    // which is the state its own click toggles
    expect(coarse.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      coarse.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(inSection.getAttribute('aria-expanded')).toBe('false');
    expect(outSection.getAttribute('aria-expanded')).toBe('false');
  });

  it('expanders come out in reading order, which is what the arrow keys walk', () => {
    const host = draw(bash);
    const labels = expanders(host).map((el) => (el.textContent ?? '').trim());
    expect(labels[0]).toContain('Bash');
    // the translated headers, not the literal 'feedView.in' this used to
    // assert: with i18next uninitialised every label WAS its own key, and the
    // check could not tell a translated section header from a missing one
    // (#380). Whole-word, because "IN"/"OUT" are two and three characters and
    // `toContain` would take them out of any passing word.
    expect(labels[1]).toMatch(new RegExp(`(^|\\s)${en.feedView.in}(\\s|$)`));
    expect(labels[2]).toMatch(new RegExp(`(^|\\s)${en.feedView.out}(\\s|$)`));
  });
});
