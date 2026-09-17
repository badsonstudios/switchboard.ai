// @vitest-environment jsdom
// §5.5's drop dialog (P2-E11-10).
//
// What only a RENDERED dialog can answer: that it opens on the fidelity §5.5
// names as the default rather than on the first row, that the coverage caveat is
// on screen BEFORE the choice rather than buried under it, that a thin option is
// marked instead of looking full, and — the one that matters most — that Cancel,
// Escape and a click on the scrim all commit nothing.
//
// The numbers themselves are `context-drop.test.ts`'s subject. This file only
// checks that what the builder said reaches the screen unchanged.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { ContextDropDialog } from './ContextDropDialog';
import { initI18nForTests } from '../i18n/test-i18n';
import type { ContextOffer, ContextOfferOption } from '../../../shared/context-drop';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let cancelled: number;
let chosen: ContextOfferOption[];

const OFFER: ContextOffer = {
  from: { id: 'sess-a', name: 'TradingApp' },
  coverage: 'whole',
  options: [
    { id: 'state', tokens: 120, empty: false, text: 'STATE-TEXT' },
    { id: 'package', tokens: 3100, empty: false, text: 'PACKAGE-TEXT' },
    { id: 'excerpt', tokens: 1500, empty: false, text: 'EXCERPT-TEXT' },
  ],
};

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  cancelled = 0;
  chosen = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(offer: ContextOffer = OFFER): Promise<void> {
  await act(async () => {
    root.render(
      <ContextDropDialog
        offer={offer}
        onCancel={() => {
          cancelled++;
        }}
        onChoose={(o) => chosen.push(o)}
      />
    );
  });
}

const rows = (): HTMLElement[] => [...host.querySelectorAll('[data-context-option]')] as HTMLElement[];
const row = (id: string): HTMLElement => host.querySelector(`[data-context-option="${id}"]`)!;
const selected = (): string | null =>
  host.querySelector('[data-selected="yes"]')?.getAttribute('data-context-option') ?? null;
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('the three fidelities §5.5 offers', () => {
  it('shows one row per fidelity, in the spec’s order', async () => {
    await mount();
    expect(rows().map((r) => r.getAttribute('data-context-option'))).toEqual([
      'state',
      'package',
      'excerpt',
    ]);
  });

  it('⚠️ opens on the SUMMARY HANDOFF — §5.5 names Level 2 as the default', async () => {
    await mount();
    // Not the first row, which is what a dialog written without reading §5.5
    // would do, and which every other assertion here would survive.
    expect(selected()).toBe('package');
    expect(row('package').getAttribute('aria-checked')).toBe('true');
    expect(row('state').getAttribute('aria-checked')).toBe('false');
  });

  it('marks which one is the default, so the choice reads as a recommendation', async () => {
    await mount();
    expect(host.querySelector('[data-context-default]')).not.toBeNull();
  });

  it('shows each option’s estimate exactly as the builder reported it', async () => {
    await mount();
    expect(row('state').getAttribute('data-context-tokens')).toBe('120');
    expect(row('package').getAttribute('data-context-tokens')).toBe('3100');
    // …and grouped for a human, without `Intl` — the same rule the package
    // itself follows, so the dialog and the document cannot disagree.
    expect(row('package').textContent).toContain('3,100');
  });
});

describe('honesty on screen', () => {
  it('states the coverage caveat, ahead of the choice', async () => {
    await mount({ ...OFFER, coverage: 'recent' });
    const line = host.querySelector('[data-context-coverage="recent"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain('most recent part');
  });

  it('says an unreadable transcript explains the EMPTY options, not the session', async () => {
    await mount({ ...OFFER, coverage: 'unreadable' });
    const line = host.querySelector('[data-context-coverage="unreadable"]')!;
    expect(line.textContent).toContain('not that the session has done nothing');
  });

  it('⚠️ marks a thin option rather than letting it look full', async () => {
    await mount({
      ...OFFER,
      options: [
        { id: 'state', tokens: 0, empty: true, text: 'x' },
        ...OFFER.options.slice(1),
      ],
    });
    expect(row('state').getAttribute('data-context-empty')).toBe('yes');
    expect(row('state').textContent).toContain('nothing recorded');
    // Still offered: an absent row and a thin one are different claims, and the
    // text is a true statement about the session either way.
    expect(rows()).toHaveLength(3);
  });

  it('says plainly that nothing is sent — where the decision is made', async () => {
    await mount();
    expect(host.textContent).toContain('Nothing is sent');
  });
});

describe('nothing is committed until OK', () => {
  it('clicking a row selects it and hands back NOTHING', async () => {
    await mount();
    await click(row('excerpt'));
    expect(selected()).toBe('excerpt');
    expect(chosen).toEqual([]);
    expect(cancelled).toBe(0);
  });

  it('OK hands back the option that was selected, once', async () => {
    await mount();
    await click(row('excerpt'));
    await click(host.querySelector('[data-context-ok]')!);
    expect(chosen.map((o) => o.id)).toEqual(['excerpt']);
    expect(chosen[0].text).toBe('EXCERPT-TEXT');
  });

  it('OK with no row touched commits the DEFAULT, not nothing', async () => {
    await mount();
    await click(host.querySelector('[data-context-ok]')!);
    expect(chosen.map((o) => o.id)).toEqual(['package']);
  });

  it('Cancel commits nothing', async () => {
    await mount();
    await click(row('state'));
    await click(host.querySelector('[data-context-cancel]')!);
    expect(chosen).toEqual([]);
    expect(cancelled).toBe(1);
  });

  it('Escape commits nothing', async () => {
    await mount();
    await act(async () => {
      host
        .querySelector('[data-testid="context-drop"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(chosen).toEqual([]);
    expect(cancelled).toBe(1);
  });

  it('a click on the scrim commits nothing — three doors, one behaviour', async () => {
    await mount();
    await act(async () => {
      host.firstElementChild!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(chosen).toEqual([]);
    expect(cancelled).toBe(1);
  });

  it('a click INSIDE the dialog is not a click-away', async () => {
    await mount();
    await act(async () => {
      host
        .querySelector('[data-testid="context-drop"]')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(cancelled).toBe(0);
  });
});

describe('the dialog is reachable without a mouse', () => {
  it('is a modal dialog with a name', async () => {
    await mount();
    const d = host.querySelector('[data-testid="context-drop"]')!;
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('aria-label')).toBeTruthy();
  });

  it('carries the selection in the accessibility tree, not only in the fill', async () => {
    await mount();
    await click(row('state'));
    expect(row('state').getAttribute('aria-checked')).toBe('true');
    expect(row('package').getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('[role="radiogroup"]')).not.toBeNull();
  });
});
