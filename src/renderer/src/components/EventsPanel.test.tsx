// @vitest-environment jsdom
// The events panel's update notice (P2-E19-04).
//
// The panel's rows, ordering and a11y are covered by `a11y-surfaces.test.tsx`
// and `feed.spec.ts`; this file is only about the one non-modal surface the
// update feature owns — and about the distinction that makes it honest:
//
//   • **installed** — the post-update handshake. News, dismissible, no action.
//   • **available** — the offer is still standing after the dialog was closed
//     without being answered. That is the item's "the persistent update
//     available affordance remains", and it is the panel's job because a
//     modal that reopens itself is not an affordance, it is a nag.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { EventsPanel } from './EventsPanel';
import type { EventDto } from '../model/types';
import type { HistoryRepairNotice } from '../../../shared/history-repair';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = {
  onUpdateNow: vi.fn(),
  onDismissUpdateNotice: vi.fn(),
};

async function render(
  notice: { kind: 'installed' | 'available'; version: string } | null
): Promise<void> {
  await act(async () => {
    root!.render(
      <EventsPanel
        sessions={[]}
        events={[]}
        queueEvents={[]}
        visited={new Set<number>()}
        onFocus={() => {}}
        onVisit={() => {}}
        queueBinding="Ctrl+Space"
        updateNotice={notice}
        {...handlers}
      />
    );
  });
}

const notice = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-events-notice]');
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const h of Object.values(handlers)) h.mockReset();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the update notice', () => {
  it('shows nothing at all when there is no notice', async () => {
    await render(null);
    expect(notice()).toBeNull();
    // …and the panel still says it is empty, rather than looking occupied
    expect(host.textContent).toContain(en.events.empty);
  });

  it('the post-update handshake names the version and only offers "got it"', async () => {
    await render({ kind: 'installed', version: '0.2.0' });
    expect(notice()?.getAttribute('data-events-notice')).toBe('installed');
    expect(notice()?.textContent).toContain('0.2.0');
    // Nothing to do — the update already happened.
    expect(() => button(en.events.updateNow)).toThrow();
    await click(button(en.events.gotIt));
    expect(handlers.onDismissUpdateNotice).toHaveBeenCalled();
  });

  it('a standing offer keeps a way back INTO the dialog', async () => {
    await render({ kind: 'available', version: '0.2.0' });
    expect(notice()?.getAttribute('data-events-notice')).toBe('available');
    expect(notice()?.textContent).toContain('0.2.0');
    await click(button(en.events.updateNow));
    expect(handlers.onUpdateNow).toHaveBeenCalled();
    expect(handlers.onDismissUpdateNotice).not.toHaveBeenCalled();
  });

  it('the offer can be waved away without answering it', async () => {
    await render({ kind: 'available', version: '0.2.0' });
    await click(button(en.events.notNow));
    expect(handlers.onDismissUpdateNotice).toHaveBeenCalled();
    expect(handlers.onUpdateNow).not.toHaveBeenCalled();
  });

  it('is made of real buttons, like everything else the a11y sweep touched', async () => {
    // The panel's standing rule: a control is a <button>, not a div with a
    // click handler. Both notices, both flavours.
    for (const kind of ['installed', 'available'] as const) {
      await render({ kind, version: '0.2.0' });
      const controls = notice()!.querySelectorAll('button');
      expect(controls.length, kind).toBeGreaterThan(0);
      for (const b of controls) expect(b.textContent?.trim()).toBeTruthy();
    }
  });
});

// #539 — the repair sweep and the duplicate untangle both move a card's
// conversation without being asked. Until this notice they reported that only
// to the log, which makes "my card came back somewhere else" indistinguishable
// from the bug the sweep exists to repair.
describe('the history-repair notice (#539)', () => {
  const onDismiss = vi.fn();
  const repair = (over: Partial<HistoryRepairNotice> = {}): HistoryRepairNotice => ({
    id: 'r1',
    kind: 'adopted',
    cardId: 'card-1',
    cardTitle: 'Switchboard.ai',
    nativeSessionId: 'conv-x',
    ...over,
  });

  async function show(repairs: HistoryRepairNotice[]): Promise<void> {
    await act(async () => {
      root!.render(
        <EventsPanel
          sessions={[]}
          events={[]}
          queueEvents={[]}
          visited={new Set<number>()}
          onFocus={() => {}}
          onVisit={() => {}}
          queueBinding="Ctrl+Space"
          historyRepairs={repairs}
          onDismissHistoryRepair={onDismiss}
        />
      );
    });
  }

  const rows = (): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>('[data-history-repair]'),
  ];

  beforeEach(() => onDismiss.mockReset());

  it('names the card that was reconnected', async () => {
    await show([repair()]);
    expect(host.querySelector('[data-events-notice="history-repair"]')).not.toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('data-history-repair')).toBe('adopted');
    expect(rows()[0].textContent).toContain('Switchboard.ai');
  });

  it('names BOTH cards when one gave a conversation up', async () => {
    await show([
      repair({ kind: 'ceded', cardTitle: 'Switchboard.ai-2', keptByTitle: 'Switchboard.ai' }),
    ]);
    expect(rows()[0].getAttribute('data-history-repair')).toBe('ceded');
    expect(rows()[0].textContent).toContain('Switchboard.ai-2');
    expect(rows()[0].textContent).toContain('Switchboard.ai');
  });

  it('announces itself — it is already true when the window mounts', async () => {
    await show([repair()]);
    const live = host.querySelector('[data-events-notice="history-repair"] [role="status"]');
    expect(live).not.toBeNull();
    expect(live!.getAttribute('aria-live')).toBe('polite');
  });

  it('is dismissible, one row at a time', async () => {
    await show([repair(), repair({ id: 'r2', cardTitle: 'other' })]);
    expect(rows()).toHaveLength(2);
    await click(rows()[1].querySelector('button')!);
    expect(onDismiss).toHaveBeenCalledWith('r2');
  });

  it('gives each dismiss button a name of its own (§5.32)', async () => {
    // three buttons all reading "Got it" would be three identical controls to
    // anyone who cannot see which row they sit in
    await show([repair(), repair({ id: 'r2', cardTitle: 'other' })]);
    const names = rows().map((r) => r.querySelector('button')!.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain('Switchboard.ai');
  });

  it('keeps the panel from claiming to be empty while it is up', async () => {
    await show([repair()]);
    expect(host.textContent).not.toContain(en.events.empty);
  });

  it('shows nothing for an empty list', async () => {
    await show([]);
    expect(host.querySelector('[data-events-notice="history-repair"]')).toBeNull();
    expect(host.textContent).toContain(en.events.empty);
  });
});

// --- The reviewed row's de-emphasis is a token pair, not an opacity (#268) ---
//
// `tokens.drift.test.ts` measures the pair the reviewed row paints — the fill
// and the ink written on it — but it reads a stylesheet, and the defect it was
// written for was an INLINE `opacity: 0.82` on the row div. That is invisible
// to it: put the opacity back beside the class and every ratio over there
// still passes, while every colour on the row loses about a point of contrast.
//
// So this is the half that has to live in the component: the row asks for the
// de-emphasis by ATTRIBUTE, and asks for nothing else. Group opacity is the
// mechanism this issue removed and the one an eye cannot audit, so it is named
// rather than left to "no inline style at all" — a row is entitled to its
// outline and its radius.
describe('a reviewed row recedes by token, never by opacity', () => {
  const evt = (id: number, kind: EventDto['kind']): EventDto => ({
    id,
    sessionId: 's1',
    kind,
    at: '2026-08-21T10:00:00.000Z',
  });

  async function rowsFor(events: EventDto[]): Promise<HTMLElement[]> {
    await act(async () => {
      root!.render(
        <EventsPanel
          sessions={[{ id: 's1', title: 'alpha', accent: 'var(--accent-blue)' }]}
          events={events}
          queueEvents={events}
          visited={new Set<number>()}
          onFocus={() => {}}
          onVisit={() => {}}
          queueBinding="Ctrl+Space"
          {...handlers}
        />
      );
    });
    return [...host.querySelectorAll<HTMLElement>('[role="listitem"]')];
  }

  it('marks the reviewed row, and only the reviewed row', async () => {
    const [needy, reviewed] = await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')]);
    expect(reviewed.getAttribute('data-reviewed')).toBe('true');
    expect(needy.getAttribute('data-reviewed')).toBeNull();
    // the attribute only does anything through the rule that reads it
    for (const row of [needy, reviewed]) expect([...row.classList]).toContain('event-row');
  });

  it('sets no inline opacity on either kind of row', async () => {
    for (const row of await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')])) {
      expect(
        row.style.opacity,
        'group opacity fades the text AND the fill toward what is behind both — ' +
          'it takes contrast off every colour on the row at once, and no token test can see it'
      ).toBe('');
    }
  });

  it("writes the row's TITLE in the row's own ink", async () => {
    // The title is the loudest thing on the row and is therefore what the
    // de-emphasis is mostly made of: `--text` on a live row, one rung down the
    // neutral ladder on a reviewed one. Spelling either token here would put
    // the step in a component, where nothing measures it — and reverting this
    // to a fixed `var(--text)` is not an AA failure (it is MORE contrast), it
    // is the reviewed tail quietly ceasing to recede at all, which is the one
    // regression a contrast test cannot have an opinion about.
    for (const row of await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')])) {
      const title = [...row.querySelectorAll<HTMLElement>('span')].find(
        (w) => w.textContent === 'alpha'
      );
      expect(title, 'the row stopped naming its session').toBeDefined();
      expect(title!.style.color).toBe('inherit');
    }
  });

  it("writes the reviewed row's state word in the row's own ink", async () => {
    // The one word on a reviewed row that says what the row IS. It used to
    // carry its own token (`--faint`, the app's hairline hint) and measured
    // 2.15:1 with the old opacity folded in — a value no test in the token
    // suite could reach, because the map that held it is a component's. It
    // inherits now, so the colour on screen IS the pair
    // `.event-row[data-reviewed='true']` declares and tokens.drift.test.ts
    // measures. A token named here again would be a second opinion about it.
    const [, reviewed] = await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')]);
    const words = [...reviewed.querySelectorAll<HTMLElement>('span')];
    const state = words.find((w) => w.textContent?.startsWith(en.events.kind.ready));
    expect(state, 'the reviewed row stopped saying what state it is in').toBeDefined();
    expect(
      state!.style.color,
      'a colour of its own here is a colour the drift test cannot see'
    ).toBe('inherit');
  });

  it('leaves the fill to the stylesheet, so the pair stays measurable', async () => {
    // an inline background would beat the rule on specificity and the drift
    // test would be measuring a colour nobody paints
    for (const row of await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')])) {
      expect(row.style.background).toBe('');
      expect(row.style.backgroundColor).toBe('');
    }
  });
});
