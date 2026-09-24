// @vitest-environment jsdom
// Clear and Compact on the composer's options row (#903).
//
// Rendered through the PANEL CONTRIBUTION, not by calling `<FeedView>`, for the
// reason `FeedView.handoff.test.tsx` spells out: the lock these buttons obey is
// computed by the CARD and has to be threaded through `PanelContext` ->
// `FeedView` -> `Composer`, and a prop that no render site writes is a guard
// that never runs. That exact defect has now shipped twice (#261, #208).
//
// `session-controls.test.ts` owns the rule and the two commands. This file owns
// the question that one cannot answer: does the row reach them, and does Clear
// ask first.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** everything main was asked to type into a session, in order */
let submitted: Array<{ id: string; text: string }>;

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    pty: { input: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve([]),
      submitPrompt: (id: string, text: string) => {
        submitted.push({ id, text });
        return Promise.resolve(true);
      },
    },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

function ctx(over: Partial<PanelContext>): PanelContext {
  return {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    status: 'idle',
    controlsLock: null,
    setView: () => {},
    ...over,
  };
}

const roots: Root[] = [];

async function mountFeed(over: Partial<PanelContext> = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(feedPanel.render(ctx(over)));
  });
  return host;
}

const btn = (host: HTMLElement, id: string): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

/**
 * The tooltip a mouse user actually gets. It sits on the WRAPPER, not on the
 * button: Chromium does not hit-test a `disabled` control, so a `title` on a
 * greyed-out button never appears — which is precisely the state in which the
 * user needs to be told why.
 */
const tip = (host: HTMLElement, id: string): string | null =>
  btn(host, id)?.parentElement?.getAttribute('title') ?? null;

const click = async (el: HTMLElement | null): Promise<void> => {
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  submitted = [];
  stubBridge();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  vi.unstubAllGlobals();
});

describe('the options row offers Clear and Compact (issue 903)', () => {
  it('both buttons are on the row, named in full for a screen reader', async () => {
    const host = await mountFeed();
    expect(btn(host, 'composer-clear')?.getAttribute('aria-label')).toBe('Clear conversation');
    expect(btn(host, 'composer-compact')?.getAttribute('aria-label')).toBe('Compact conversation');
    // short where it is read, full where it is announced
    expect(btn(host, 'composer-clear')?.textContent).toBe('Clear');
    expect(btn(host, 'composer-compact')?.textContent).toBe('Compact');
    // the menu's existing hints, not new copy invented for a second surface
    expect(tip(host, 'composer-compact')).toContain('Types /compact');
    expect(tip(host, 'composer-clear')).toContain('Types /clear');
  });

  it('Compact sends straight away — it is not the destructive one', async () => {
    const host = await mountFeed();
    await click(btn(host, 'composer-compact'));
    expect(submitted).toEqual([{ id: 'live-1', text: '/compact' }]);
  });

  // Clear leaves a divider in the conversation; Compact leaves NOTHING on
  // screen, so a second click on a button that still looks live types the
  // command twice and the user has no way to tell.
  it('Compact goes dead while it is on the wire, so a double click sends once', async () => {
    const host = await mountFeed();
    await act(async () => {
      btn(host, 'composer-compact')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn(host, 'composer-compact')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(submitted).toEqual([{ id: 'live-1', text: '/compact' }]);
    // …and it comes back once the send settles, or the button is a one-shot
    await act(async () => {});
    expect(btn(host, 'composer-compact')?.disabled).toBe(false);
  });

  // The confirmation is done-when 2's "including Clear's confirmation, which
  // stays". A button that cleared on the first click would pass every other
  // assertion in this file.
  it('Clear ASKS first, and the first click sends nothing at all', async () => {
    const host = await mountFeed();
    await click(btn(host, 'composer-clear'));
    expect(submitted).toEqual([]);
    expect(host.textContent).toContain('Clear conversation?');
    await click(btn(host, 'composer-clear-go'));
    expect(submitted).toEqual([{ id: 'live-1', text: '/clear' }]);
  });

  it('cancelling the question sends nothing and puts the row back', async () => {
    const host = await mountFeed();
    await click(btn(host, 'composer-clear'));
    await click(btn(host, 'composer-clear-cancel'));
    expect(submitted).toEqual([]);
    expect(btn(host, 'composer-clear')).not.toBeNull();
    expect(btn(host, 'composer-clear-go')).toBeNull();
  });

  // THE FOCUS PAIR, and the review finding that made it. Asking the question
  // unmounts the button that was focused, which drops focus on `body` — from
  // there the Escape handler (a React synthetic listener on the group) is
  // unreachable, and a screen reader is told nothing happened at all.
  it('asking the question moves focus INTO it, onto the safe answer', async () => {
    const host = await mountFeed();
    await click(btn(host, 'composer-clear'));
    expect(document.activeElement).toBe(btn(host, 'composer-clear-cancel'));
  });

  it('answering the question returns focus to the button that asked it', async () => {
    const host = await mountFeed();
    await click(btn(host, 'composer-clear'));
    await click(btn(host, 'composer-clear-cancel'));
    expect(document.activeElement).toBe(btn(host, 'composer-clear'));
  });

  // The confirm must not be announced with the SAME WORDS as the button that
  // opened the question. Identical names are how a screen-reader user hears
  // "Clear conversation, button" twice, believes nothing has happened yet, and
  // presses the one that wipes.
  it('the confirm is audibly an ANSWER, not a second copy of the trigger', async () => {
    const host = await mountFeed();
    const trigger = btn(host, 'composer-clear')!.getAttribute('aria-label');
    await click(btn(host, 'composer-clear'));
    const confirm = btn(host, 'composer-clear-go')!.getAttribute('aria-label');
    expect(confirm).not.toBe(trigger);
    expect(confirm).toBe('Yes, clear this conversation');
    expect(btn(host, 'composer-clear-cancel')?.getAttribute('aria-label')).toBe(
      'No, keep this conversation'
    );
    // and the whole sentence is on the group focus lands in
    expect(
      host.querySelector('[role="group"]')?.getAttribute('aria-label')
    ).toContain('context starts over');
  });

  // Escape from where focus ACTUALLY IS after the question opens — which is
  // the point of the test. Dispatching it at a hand-picked element would pass
  // against the bug above.
  it('Escape backs out of the question, from wherever the question put focus', async () => {
    const host = await mountFeed();
    await click(btn(host, 'composer-clear'));
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(btn(host, 'composer-clear-go')).toBeNull();
    expect(submitted).toEqual([]);
  });
});

describe('the row obeys the CARD lock, not its own reading of the status', () => {
  it('a starting session has both buttons disabled, and says why in the name', async () => {
    const host = await mountFeed({ status: 'starting', controlsLock: 'starting' });
    expect(btn(host, 'composer-clear')?.disabled).toBe(true);
    expect(btn(host, 'composer-compact')?.disabled).toBe(true);
    // the reason is in the NAME as well as the tooltip: a tooltip is a mouse
    // affordance, and this button's whole audience here is people not using one
    expect(btn(host, 'composer-clear')?.getAttribute('aria-label')).toContain('Still starting');
    // the tooltip says it too — on the wrapper, which is the only place a
    // disabled control can carry one the browser will actually show
    expect(tip(host, 'composer-clear')).toContain('Still starting');
  });

  it('a dead session says the ENDED reason, which is a different sentence', async () => {
    const host = await mountFeed({ status: 'crashed', controlsLock: 'dead' });
    expect(btn(host, 'composer-compact')?.getAttribute('aria-label')).toContain('has ended');
    expect(btn(host, 'composer-compact')?.disabled).toBe(true);
  });

  // THE REASON THE LOCK IS A PROP. A card whose session exited cleanly reports
  // a perfectly ordinary status word; only the card knows it is gone. A row
  // that re-derived the lock from `status` would offer a live Clear here, and
  // every other test in this file would still pass.
  it('a cleanly-exited session is locked even though its status looks fine', async () => {
    const host = await mountFeed({ status: 'done', controlsLock: 'dead' });
    expect(btn(host, 'composer-clear')?.disabled).toBe(true);
  });

  it('…and an ordinary idle session is NOT locked — the lock must not be a blanket', async () => {
    const host = await mountFeed({ status: 'done', controlsLock: null });
    expect(btn(host, 'composer-clear')?.disabled).toBe(false);
  });

  // A session can die with the question on screen. Leaving it up would put a
  // live-looking Clear in front of a session there is nothing left to clear.
  it('a session that dies mid-question takes the question with it', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(feedPanel.render(ctx({}))));
    await click(btn(host, 'composer-clear'));
    expect(btn(host, 'composer-clear-go')).not.toBeNull();

    await act(async () => root.render(feedPanel.render(ctx({ controlsLock: 'dead' }))));
    expect(btn(host, 'composer-clear-go')).toBeNull();
    expect(btn(host, 'composer-clear')?.disabled).toBe(true);
    expect(submitted).toEqual([]);
    // focus does NOT go back to the button that asked — it is disabled now, so
    // `.focus()` there is a silent no-op and the user is left on `body`
    expect(document.activeElement).toBe(host.querySelector('textarea'));
  });
});

// The row is `display: flex` and a card can be narrow. It WRAPS rather than
// overflowing — see the style's own note, and #885, where a row that looked
// fine on Windows was 38px short on Linux CI.
describe('the row cannot overflow', () => {
  it('wraps instead of running off the end of a narrow card', async () => {
    const host = await mountFeed();
    const row = host.querySelector<HTMLElement>('[data-testid="composer-options"]');
    expect(row).not.toBeNull();
    expect(row!.style.flexWrap).toBe('wrap');
  });
});
