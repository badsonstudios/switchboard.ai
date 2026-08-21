// @vitest-environment jsdom
// §5.8's idle aggregation, as the user meets it (P2-E9-08).
//
// lib/ladder's tests own the RULE — which rows fold, and where the fold sits.
// This file owns the two things only a mounted component can answer: that the
// summary actually says "4 idle sessions" in English (an ICU plural that is
// wrong in exactly one direction and silent about it), and that the disclosure
// is a real way back to a session rather than a decoration — open the fold,
// click the session, and the strip asks for it to be expanded.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { CollapsedStrip } from './CollapsedStrip';
import { collapsedRows, CollapsedRow } from '../lib/ladder';
import type { CardStatus } from '../../../shared/sessions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const expanded: string[] = [];

const rowOf = (cardId: string, status: CardStatus): CollapsedRow =>
  collapsedRows([{ id: cardId, title: cardId, status }], () => 'collapsed')[0];

async function mount(rows: readonly CollapsedRow[], activeCardId?: string): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <CollapsedStrip
        rows={rows}
        activeCardId={activeCardId ?? null}
        onExpand={(id) => expanded.push(id)}
      />
    );
  });
}

const fold = (): HTMLElement | null => document.body.querySelector('[data-idle-fold]');
const sessionRows = (): HTMLElement[] => [
  ...document.body.querySelectorAll<HTMLElement>('[data-collapsed-row]'),
];
async function click(el: HTMLElement | null): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('the collapsed strip folds idle sessions (E9-08)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    expanded.length = 0;
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('draws three idle sessions as three ordinary rows', async () => {
    await mount([rowOf('a', 'idle'), rowOf('b', 'idle'), rowOf('c', 'idle')]);
    expect(fold()).toBeNull();
    expect(sessionRows()).toHaveLength(3);
  });

  it('draws four as one row that says how many, and keeps a waiting session out', async () => {
    await mount([
      rowOf('held', 'needs-permission'),
      rowOf('a', 'idle'),
      rowOf('b', 'idle'),
      rowOf('c', 'idle'),
      rowOf('d', 'idle'),
    ]);
    expect(fold()?.textContent).toContain('4 idle sessions');
    expect(fold()?.getAttribute('data-idle-fold')).toBe('4');
    // the session that needs a human is the one row you were looking for
    expect(sessionRows().map((r) => r.getAttribute('data-collapsed-row'))).toEqual(['held']);
  });

  it('says "1 idle session" if it ever has to — the plural has two arms', async () => {
    // not reachable through the threshold today; asserted because an ICU plural
    // with a broken `one` arm fails silently the first time the rule changes
    expect(i18next.t('ladder.idleFold', { count: 1 })).toBe('1 idle session');
    expect(i18next.t('ladder.idleFold', { count: 4 })).toBe('4 idle sessions');
  });

  it('opens on a click, and a session inside it is one more click from coming back', async () => {
    await mount([rowOf('a', 'idle'), rowOf('b', 'idle'), rowOf('c', 'idle'), rowOf('d', 'idle')]);
    expect(sessionRows()).toHaveLength(0);
    expect(fold()?.getAttribute('aria-expanded')).toBe('false');

    await click(fold());
    expect(fold()?.getAttribute('aria-expanded')).toBe('true');
    expect(sessionRows().map((r) => r.getAttribute('data-collapsed-row'))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);

    // §4's two-gesture rule, counted: that was gesture one, this is gesture two
    await click(sessionRows()[2]);
    expect(expanded).toEqual(['c']);

    // ...and it folds back up again
    await click(fold());
    expect(sessionRows()).toHaveLength(0);
  });

  it('renders nothing at all when nothing is collapsed', async () => {
    await mount([]);
    expect(document.body.querySelector('[data-testid="collapsed-strip"]')).toBeNull();
  });

  it('keeps the strip on --panel, which a needing row’s contrast is measured against', async () => {
    // #246. `.collapsed-row[data-needs-you='true']` fills with `color-mix(…
    // var(--row-hue) 14%, var(--panel))`, and tokens.drift.test.ts computes the
    // ratio of the state's ink against exactly that. The `--panel` in the rule
    // is only true because THIS container paints it — the row's own fill is
    // translucent, so what is behind it is what the word really sits on. Move
    // the strip onto `--chip` or `--bar` and every one of those 48 assertions
    // goes on passing while measuring a surface that is no longer there.
    //
    // tokens.css says so in capitals; a capitalised comment is not a guard.
    await mount([rowOf('a', 'needs-input')]);
    const strip = document.body.querySelector<HTMLElement>('[data-testid="collapsed-strip"]');
    expect(strip, 'no strip to check').not.toBeNull();
    expect(
      strip!.style.background,
      'the collapsed strip must stay on --panel, or the needing row’s measured contrast is a fiction'
    ).toBe('var(--panel)');
  });
});
