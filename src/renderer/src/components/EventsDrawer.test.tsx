// @vitest-environment jsdom
// The Events drawer (P2-E14-01, Shape B).
//
// The panel's CONTENT is covered where it always was — `EventsPanel.test.tsx`
// for the update notice, `a11y-surfaces.test.tsx` for the rows and the live
// regions, `service-health-surfaces.test.tsx` for the incidents card. Nothing
// about any of that changed, and this file deliberately does not re-test it.
//
// What is new is the SHAPE, and the shape is where the item's risk is: a panel
// that used to be unmissable is now shut by default, so everything that made it
// worth having has to survive being folded into one tab and a way back out.
// That is what this file holds — the tab's three signals, the three ways in,
// the way out, and the promise that closing chrome never removes capability
// (§5.8).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { EventsDrawer } from './EventsDrawer';
import type { EventDto } from '../model/types';
import type { RailSession } from './SessionsRail';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const sessions: RailSession[] = [
  { id: 'c1', title: 'alpha', accent: 'var(--accent-blue)', liveId: 'live-1' },
];

const ev = (id: number, kind: EventDto['kind']): EventDto => ({
  id,
  sessionId: 'live-1',
  kind,
  at: `2026-08-13T10:0${id}:00.000Z`,
});

interface Options {
  open?: boolean;
  events?: EventDto[];
  reconnectOffer?: boolean;
  updateNotice?: { kind: 'installed' | 'available'; version: string } | null;
  incidents?: readonly { id: string; name: string; status: string }[];
}

const onOpen = vi.fn();
const onClose = vi.fn();

async function render(o: Options = {}): Promise<void> {
  const events = o.events ?? [];
  await act(async () => {
    root!.render(
      <EventsDrawer
        open={o.open ?? false}
        onOpen={onOpen}
        onClose={onClose}
        drawerBinding="Ctrl+E"
        sessions={sessions}
        events={events}
        queueEvents={events}
        visited={new Set<number>()}
        onFocus={() => {}}
        onVisit={() => {}}
        queueBinding="Ctrl+Space"
        reconnectOffer={o.reconnectOffer}
        onRestoreLayout={() => {}}
        onDismissOffer={() => {}}
        updateNotice={o.updateNotice ?? null}
        onUpdateNow={() => {}}
        onDismissUpdateNotice={() => {}}
        incidents={o.incidents}
      />
    );
  });
}

const tab = (): HTMLButtonElement => {
  const el = host.querySelector<HTMLButtonElement>('[data-testid="events-tab"]');
  if (!el) throw new Error('the drawer has no tab — nothing is reachable without one');
  return el;
};
const body = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="events-drawer"]');

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** the drawer hands focus back on a frame, not synchronously — wait for it */
async function frames(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  onOpen.mockReset();
  onClose.mockReset();
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

describe('collapsed is the default, and the tab is what is left', () => {
  it('renders no panel body at all when shut', async () => {
    await render({ events: [ev(1, 'needs-input')] });
    expect(body()).toBeNull();
    // and the rows are genuinely GONE, not merely invisible — a hidden copy of
    // the panel would keep the a11y tree talking about work you cannot reach,
    // and would make every "the row went away" assertion vacuously true
    expect(host.querySelector('[data-event-kind]')).toBeNull();
  });

  it('still offers the tab, so the capability was folded and not removed', async () => {
    await render();
    expect(tab().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the tab carries the three signals', () => {
  it('counts the sessions waiting', async () => {
    await render({ events: [ev(1, 'needs-input'), ev(2, 'done')] });
    expect(tab().getAttribute('data-count')).toBe('2');
    expect(tab().textContent).toContain('2');
  });

  it('is tinted by the hottest of them, not the newest', async () => {
    await render({ events: [ev(1, 'done'), ev(2, 'needs-permission')] });
    expect(tab().getAttribute('data-hottest')).toBe('needs-permission');
  });

  it('shows no count and no tint when nothing is waiting', async () => {
    await render({ events: [ev(1, 'ready')] });
    expect(tab().getAttribute('data-count')).toBe('0');
    expect(tab().getAttribute('data-hottest')).toBeNull();
  });

  // The #425 coordination note, at the one moment it matters: all three notice
  // tenants moved into a surface that is shut by default, so all three have to
  // be able to say so from behind it.
  for (const [what, opts] of [
    ['the update notice', { updateNotice: { kind: 'available' as const, version: '0.6.0' } }],
    ['the reconnect offer', { reconnectOffer: true }],
    ['an open incident', { incidents: [{ id: 'i', name: 'API', status: 'degraded' }] }],
  ] as const) {
    it(`raises the secondary marker for ${what}`, async () => {
      await render(opts);
      expect(tab().getAttribute('data-notice')).toBe('true');
      expect(host.querySelector('[data-testid="events-tab-notice"]')).not.toBeNull();
    });
  }

  // The dot is invisible to a screen reader, and the panel's own three
  // `role="status"` regions are not in the DOM while the drawer is shut — so
  // without this region, collapsing by default would have silently stopped
  // announcing updates and reconnect offers altogether. That is capability
  // removed by hiding chrome, which §5.8 forbids.
  const announcer = (): HTMLElement | null =>
    host.querySelector<HTMLElement>('[data-testid="events-announcer"]');

  it('keeps a live region mounted while collapsed, so a notice can be heard', async () => {
    await render();
    expect(announcer(), 'the region must exist BEFORE the news does').not.toBeNull();
    expect(announcer()!.getAttribute('aria-live')).toBe('polite');
    expect(announcer()!.textContent).toBe(''); // mounted empty — nothing to say yet
  });

  it('announces a notice that arrives behind a shut drawer', async () => {
    await render();
    await render({ reconnectOffer: true });
    expect(announcer()!.textContent).toContain('1 notice');
    expect(announcer()!.textContent).toContain('Ctrl+E');
  });

  it('says nothing while the drawer is OPEN — the panel is announcing there', async () => {
    await render({ open: true, reconnectOffer: true });
    expect(announcer()!.textContent).toBe('');
  });

  it('has no marker when no notice is up', async () => {
    await render({ events: [ev(1, 'crashed')] });
    expect(tab().getAttribute('data-notice')).toBeNull();
  });

  // §5.32: the count and the colour are never the only witness. Everything the
  // tab says with a number and a hue it also says in words.
  it('says all of it in its accessible name', async () => {
    await render({ events: [ev(1, 'needs-input')], reconnectOffer: true });
    const name = tab().getAttribute('aria-label') ?? '';
    expect(name).toContain('Events');
    expect(name).toContain('1 session waiting');
    expect(name).toContain('1 notice');
    // the children are decorative — the button's own label is the sentence
    expect([...tab().children].every((c) => c.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('advertises its accelerator, so the mouse route teaches the keyboard one', async () => {
    await render();
    expect(tab().getAttribute('title')).toContain('Ctrl+E');
  });
});

describe('opening and closing', () => {
  it('the tab asks App to open, and App is the one that decides', async () => {
    await render();
    await click(tab());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the same tab shuts it again', async () => {
    await render({ open: true });
    expect(tab().getAttribute('aria-expanded')).toBe('true');
    await click(tab());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the panel content once open', async () => {
    await render({ open: true, events: [ev(1, 'needs-input')] });
    expect(body()).not.toBeNull();
    expect(host.querySelectorAll('[data-event-kind]')).toHaveLength(1);
  });

  it('all three notices render in the open drawer, together', async () => {
    await render({
      open: true,
      updateNotice: { kind: 'available', version: '0.6.0' },
      reconnectOffer: true,
      incidents: [{ id: 'i', name: 'API', status: 'degraded' }],
    });
    expect(host.querySelector('[data-events-notice="incident"]')).not.toBeNull();
    expect(host.querySelector('[data-events-notice="available"]')).not.toBeNull();
    // the reconnect offer has no data attribute of its own; its live region is
    // the witness, and there are three of them only when all three are up.
    // Scoped to the BODY: the drawer keeps a fourth live region of its own,
    // always mounted, which is what announces a notice while it is shut.
    expect(body()!.querySelectorAll('[role="status"]').length).toBe(3);
  });

  it('points aria-controls at the body only while there is one', async () => {
    await render();
    expect(tab().getAttribute('aria-controls')).toBeNull();
    await render({ open: true });
    expect(tab().getAttribute('aria-controls')).toBe(body()!.id);
  });
});

describe('the keyboard way out (§5.32)', () => {
  it('Escape inside the drawer closes it', async () => {
    await render({ open: true });
    await act(async () => {
      body()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still answers Escape after a control unmounted under the caret', async () => {
    // Dismissing the last row — or taking an update, or answering the reconnect
    // offer — removes the focused button and drops the caret on <body>. A
    // handler bound to the drawer's own element would never see another key
    // from there, so Escape would go dead in exactly the state the drawer's own
    // work leaves you in.
    await render({ open: true });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone when it belongs to something else on the page', async () => {
    // the guard that keeps the document-level listener from being a global
    // grab: a dialog, a terminal or the composer is the target of its own key
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    await render({ open: true });
    await act(async () => {
      elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves every other key alone', async () => {
    await render({ open: true });
    await act(async () => {
      body()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus into the drawer when it opens', async () => {
    // otherwise a drawer opened from the palette or the hotkey would be one you
    // can see and cannot read — §5.8's invariant fails on the second half
    await render({ open: true, events: [ev(1, 'needs-input')] });
    expect(document.activeElement).toBe(body());
  });

  // The drawer has FOUR ways to shut and only two of them are gestures it can
  // see: the tab and Escape reach its own handlers, `Mod+E` and the palette
  // change `open` underneath it and nothing else. So the hand-back hangs off
  // the state transition, and these two cover the routes that never touch a
  // handler here — the ones that used to drop focus on `<body>`, where the only
  // way out is Tabbing from the top of the document.
  it('hands focus back when it is shut from outside — the hotkey route', async () => {
    await render({ open: true });
    expect(document.activeElement).toBe(body());
    await render({ open: false }); // exactly what Mod+E and the palette do
    await frames();
    expect(document.activeElement).toBe(tab());
  });

  it('does not yank focus back from wherever the user put it', async () => {
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    await render({ open: true });
    await render({ open: false });
    elsewhere.focus(); // the user clicked a terminal on the way out
    await frames();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('re-anchors on every open, so a stale return target cannot strand you', async () => {
    // opened from a CARD once (the palette route) and from the TAB after: the
    // second Escape has to land on the tab you just pressed, not on a card you
    // left three gestures ago
    const card = document.createElement('button');
    document.body.appendChild(card);
    card.focus();
    await render({ open: true });
    await render({ open: false });
    await frames();
    expect(document.activeElement, 'the palette route did not restore its anchor').toBe(card);

    tab().focus();
    await render({ open: true });
    await render({ open: false });
    await frames();
    expect(document.activeElement).toBe(tab());
  });

  it('is not a focus trap — the body is not in the tab order itself', async () => {
    // `tabIndex=-1` is programmatically focusable and NOT tabbable: Tab from
    // inside walks out into the app, which is what a non-modal surface over a
    // live workspace must do (the FindBar precedent, and 2.1.2)
    await render({ open: true });
    expect(body()!.getAttribute('tabindex')).toBe('-1');
  });
});
