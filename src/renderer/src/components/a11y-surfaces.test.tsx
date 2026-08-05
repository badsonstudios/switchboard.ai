// @vitest-environment jsdom
// The a11y contract of the four surfaces #197 swept, as an executable claim.
//
// The defect was one shape repeated: a `div` with an `onClick`, no role, no
// accessible name and no way in from the keyboard. #174 fixed it in the feed
// and set the rule the sweep follows — a REAL button on the thing being
// operated, the container kept as a role-less mouse convenience, honest roles
// only where they are true. What rots is the next edit to any of these files
// quietly turning a control back into a div, so the assertions below go through
// the real components and read the contract off the DOM.
//
// The tab strip is the one surface not here: it lives inside SessionGrid, whose
// tree is a live dockview, so its semantics are covered by `tabstrip-keys` (the
// decisions) and by e2e (the roles and the walk, in a real window).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import ICU from 'i18next-icu';
import en from '../i18n/locales/en.json';
import { SessionsRail } from './SessionsRail';
import { EventsPanel } from './EventsPanel';
import { UrgencyStrip } from './UrgencyStrip';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { uiDelete } from '../lib/ui-state';
import { RailGroup, RailSession, EventDto } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

/** mount a tree and hand back the host element */
async function mount(tree: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(tree);
  });
  return host;
}

const noop = (): void => {};

const sessions: RailSession[] = [
  { id: 'c1', title: 'switchboard', status: 'working', groupId: 'g1' },
  { id: 'c2', title: 'brainharbor', status: 'needs-permission', groupId: 'g1' },
  { id: 'c3', title: 'loose one', status: 'idle', taskLabel: 'refactor the parser' },
];
const groups: RailGroup[] = [{ id: 'g1', name: 'Work', color: 'var(--status-working)' }];

async function mountRail(selectedId: string | null = 'c1'): Promise<HTMLElement> {
  return mount(
    <SessionsRail
      sessions={sessions}
      groups={groups}
      selectedId={selectedId}
      palette={['var(--status-working)', 'var(--status-crashed)']}
      policies={DEFAULT_BOOK}
      onRename={noop}
      onFocus={noop}
      onDiff={noop}
      onClose={noop}
      onCreateGroup={noop}
      onRenameGroup={noop}
      onRecolorGroup={noop}
      onDeleteGroup={noop}
      onOpenInGroup={noop}
      onMoveToGroup={noop}
      pinned={new Set()}
      onTogglePin={noop}
      onSetSessionPolicy={noop}
      onCycleGroupPolicy={noop}
    />
  );
}

const events: EventDto[] = [
  { id: 1, sessionId: 'live-1', kind: 'needs-permission', at: '2026-08-04T10:00:00.000Z' },
  { id: 2, sessionId: 'live-3', kind: 'done', at: '2026-08-04T10:01:00.000Z' },
];

async function mountEvents(): Promise<HTMLElement> {
  return mount(
    <EventsPanel
      sessions={[
        { ...sessions[0], liveId: 'live-1' },
        { ...sessions[2], liveId: 'live-3' },
      ]}
      events={events}
      visited={new Set<number>()}
      onFocus={noop}
      onVisit={noop}
      queueBinding="Ctrl+Space"
    />
  );
}

/** every element the DOM says can be focused, in document order */
function focusables(host: HTMLElement): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')
  );
}

/** the accessible name, to the depth these components actually use */
function name(el: HTMLElement): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
}

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next
      .use(ICU)
      .use(initReactI18next)
      .init({
        lng: 'en',
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
  }
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  // the rail persists collapsed groups through ui-state, and the module-level
  // cache outlives a test — one collapse would silently reorder every row the
  // tests after it look at
  uiDelete(['railCollapsed', 'railWidth']);
  (window as unknown as { switchboard: unknown }).switchboard = {
    events: { ack: () => Promise.resolve(), dismiss: () => Promise.resolve() },
  };
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('sessions rail rows (issue 197)', () => {
  it('gives every row a real button carrying its name AND its state', async () => {
    const host = await mountRail();
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-rail-open]'));
    expect(rows).toHaveLength(sessions.length);
    for (const r of rows) expect(r.tagName).toBe('BUTTON');

    // the state used to live only in a decorative glyph, where no screen
    // reader would ever have read it
    expect(name(rows[0])).toBe('switchboard — working');
    expect(name(rows[1])).toBe('brainharbor — Wants permission to run');
  });

  it("keeps the row's own second line inside its accessible name", async () => {
    // aria-label REPLACES the contents, so a task label that is not folded in
    // here is readable to the eye and to nobody else
    const host = await mountRail();
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-rail-open]'));
    expect(name(rows[2])).toBe('loose one — refactor the parser, idle');
  });

  it('marks the row the grid is showing with aria-current, and only that one', async () => {
    const host = await mountRail('c2');
    const current = host.querySelectorAll('[data-rail-open][aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('data-rail-open')).toBe('c2');
  });

  it('leaves nothing but the row button and its ✕ in the tab order of a row', async () => {
    // the status glyph and the accent bar are decoration; if either ever grows
    // a tabindex it is a stop that announces nothing
    const host = await mountRail();
    const row = host.querySelector<HTMLElement>('.rail-row')!;
    const stops = focusables(row);
    expect(stops.map((s) => s.className)).toEqual(['rail-row-open', 'rail-x']);
    expect(name(stops[1])).toBe(en.rail.closeSession);
  });

  it('hides the decorative status glyph from screen readers', async () => {
    const host = await mountRail();
    // 'idle' renders the glyph, 'working' the spinner ring — both decoration
    const row = host.querySelectorAll<HTMLElement>('.rail-row')[2];
    // the glyph is the one span carrying a mouse tooltip; the accent bar is
    // aria-hidden too and would pass a looser query without proving anything
    const glyph = row.querySelector<HTMLElement>('span[title]');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('span[aria-label]')).toBeNull();
  });

  it('makes the group header a disclosure that says which body it opens', async () => {
    const host = await mountRail();
    const toggle = host.querySelector<HTMLElement>('[data-rail-group-toggle]')!;
    expect(toggle.tagName).toBe('BUTTON');
    expect(name(toggle)).toBe('Work');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // the reference must resolve — a dangling aria-controls is worse than none
    const bodyId = toggle.getAttribute('aria-controls')!;
    expect(bodyId).toBeTruthy();
    expect(host.querySelector(`[id="${bodyId}"]`)).not.toBeNull();
  });

  it('keeps aria-controls resolvable once the group is collapsed', async () => {
    const host = await mountRail();
    const toggle = host.querySelector<HTMLElement>('[data-rail-group-toggle]')!;
    await act(async () => toggle.click());

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = host.querySelector<HTMLElement>(`[id="${toggle.getAttribute('aria-controls')}"]`);
    expect(body).not.toBeNull();
    expect(body!.hidden).toBe(true);
    // and nothing inside a collapsed group is still a tab stop
    expect(focusables(body!)).toHaveLength(0);
  });

  it('makes the recolor dot a named button instead of a click-only span', async () => {
    const host = await mountRail();
    const dot = host.querySelector<HTMLElement>('.rail-dot')!;
    expect(dot.tagName).toBe('BUTTON');
    expect(name(dot)).toBe(en.rail.recolorGroup);
  });

  it('opens a walkable menu on contextmenu and puts focus in it', async () => {
    // contextmenu is what Shift+F10 and the ContextMenu key fire, so this IS
    // the keyboard path to the rail's diff / rename / close / policy commands
    const host = await mountRail();
    const row = host.querySelector<HTMLElement>('.rail-row')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('aria-label')).toBe('Actions for switchboard');

    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    expect(items.length).toBeGreaterThan(3);
    for (const i of items) expect(i.tagName).toBe('BUTTON'); // Enter/Space for free
    expect(document.activeElement).toBe(items[0]);
  });

  it('walks the menu with the arrows and wraps at both ends', async () => {
    const host = await mountRail();
    const row = host.querySelector<HTMLElement>('.rail-row')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    const key = async (k: string): Promise<void> => {
      await act(async () => {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    };

    await key('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await key('End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    await key('ArrowDown'); // a closed ring, not a dead key
    expect(document.activeElement).toBe(items[0]);
    await key('ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    await key('Home');
    expect(document.activeElement).toBe(items[0]);
  });

  it('hands focus back to the row when Escape closes the menu', async () => {
    const host = await mountRail();
    const opener = host.querySelector<HTMLElement>('[data-rail-open]')!;
    opener.focus();
    await act(async () => {
      opener.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('events panel rows (issue 197)', () => {
  it('is a real list of real buttons', async () => {
    const host = await mountEvents();
    const list = host.querySelector<HTMLElement>('[role="list"]')!;
    // labelled BY the panel's own heading, not by a second copy of the word
    const labelledBy = list.getAttribute('aria-labelledby')!;
    expect(host.querySelector(`[id="${labelledBy}"]`)?.textContent).toBe(en.events.eyebrow);
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(events.length);

    const opens = Array.from(host.querySelectorAll<HTMLElement>('[data-event-open]'));
    expect(opens).toHaveLength(events.length);
    for (const o of opens) expect(o.tagName).toBe('BUTTON');
  });

  it("names each row with the whole event, not just the session's title", async () => {
    const host = await mountEvents();
    const first = host.querySelector<HTMLElement>('[data-event-open]')!;
    expect(name(first)).toContain('switchboard');
    expect(name(first)).toContain(en.events.kind['needs-permission']);
  });

  it('keeps Dismiss reachable — a sibling of the open button, not inside it', async () => {
    // nested inside, it would have been unreachable by keyboard AND invisible
    // to a screen reader, since a button takes presentational children
    const host = await mountEvents();
    const row = host.querySelector<HTMLElement>('[role="listitem"]')!;
    const open = row.querySelector<HTMLElement>('[data-event-open]')!;
    const dismiss = row.querySelector<HTMLElement>('.event-dismiss')!;

    expect(dismiss.tagName).toBe('BUTTON');
    expect(open.contains(dismiss)).toBe(false);
    expect(focusables(row).map((f) => f.className)).toEqual(['event-open', 'event-dismiss']);
  });

  it('opens the session from the keyboard, and counts that as a visit', async () => {
    // the row's click already did both; the point is that the BUTTON does too,
    // so Enter is not a lesser gesture than a click
    const focused: string[] = [];
    const visited: number[] = [];
    await mount(
      <EventsPanel
        sessions={[{ ...sessions[0], liveId: 'live-1' }]}
        events={[events[0]]}
        visited={new Set<number>()}
        onFocus={(id) => focused.push(id)}
        onVisit={(id) => visited.push(id)}
        queueBinding="Ctrl+Space"
      />
    );
    const open = document.querySelector<HTMLElement>('[data-event-open]')!;
    await act(async () => open.click()); // what Enter on a button does

    expect(focused).toEqual(['c1']);
    expect(visited).toEqual([1]);
  });
});

describe('urgency lamps (issue 197)', () => {
  it('are named buttons — one per session, each saying its state', async () => {
    const host = await mount(
      <UrgencyStrip
        sessions={sessions}
        urgency={new Map<string, number>()}
        activeCardId="c2"
        onFocus={noop}
        onExpire={noop}
      />
    );
    const lamps = Array.from(host.querySelectorAll<HTMLElement>('[data-urgency-lamp]'));
    expect(lamps).toHaveLength(sessions.length);
    for (const l of lamps) expect(l.tagName).toBe('BUTTON');
    expect(name(lamps[0])).toBe('switchboard — working');
  });

  it('says which lamp you are on, not only in color', async () => {
    const host = await mount(
      <UrgencyStrip
        sessions={sessions}
        urgency={new Map<string, number>()}
        activeCardId="c2"
        onFocus={noop}
        onExpire={noop}
      />
    );
    const current = host.querySelectorAll('[data-urgency-lamp][aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('data-urgency-lamp')).toBe('c2');
  });
});
