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
// The events panel's two NOTICES (#314) are here for the same reason under a
// different defect: not a control that lost its role, but a message that arrives
// with nobody told about it. Same file because it is the same question — what
// does this DOM actually promise a screen reader.
//
// The tab strip is the one surface not here: it lives inside SessionGrid, whose
// tree is a live dockview, so its semantics are covered by `tabstrip-keys` (the
// decisions) and by e2e (the roles and the walk, in a real window).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../i18n/locales/en.json';
import { SessionsRail } from './SessionsRail';
import { EventsPanel } from './EventsPanel';
import { UrgencyStrip } from './UrgencyStrip';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DEFAULT_FOCUS_BOOK } from '../lib/focus-policy';
import { uiDelete } from '../lib/ui-state';
import { RailGroup, RailSession, EventDto } from '../model/types';
import { NO_ORDER } from '../lib/rail-order';

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

/** the rail with the shared fixture, overridable where a test needs it to be */
function rail(
  over: {
    sessions?: RailSession[];
    groups?: RailGroup[];
    selectedId?: string | null;
    onMoveToGroup?: (cardId: string, groupId: string | null) => void;
  } = {}
): React.JSX.Element {
  return (
    <SessionsRail
      sessions={over.sessions ?? sessions}
      groups={over.groups ?? groups}
      needing={new Set<string>()}
      selectedId={'selectedId' in over ? (over.selectedId ?? null) : 'c1'}
      palette={['var(--status-working)', 'var(--status-crashed)']}
      policies={DEFAULT_BOOK}
      focusPolicies={DEFAULT_FOCUS_BOOK}
      onRename={noop}
      onFocus={noop}
      onDiff={noop}
      onClose={noop}
      onCreateGroup={noop}
      onRenameGroup={noop}
      onRecolorGroup={noop}
      onDeleteGroup={noop}
      onOpenInGroup={noop}
      onMoveToGroup={over.onMoveToGroup ?? noop}
      pinned={new Set()}
      onTogglePin={noop}
      onSetSessionPolicy={noop}
      onSetSessionFocusPolicy={noop}
      onCycleGroupPolicy={noop}
        manualOrder={NO_ORDER}
        onReorder={noop}
    />
  );
}

async function mountRail(selectedId: string | null = 'c1'): Promise<HTMLElement> {
  return mount(rail({ selectedId }));
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
      queueEvents={events}
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
  await initI18nForTests();
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

  it("reads each override set as ONE choice, not as loose commands", async () => {
    // The menu carries four grouped choices now — #559's "order in this
    // group", #253's "move to group", E9-06's "on submit" and E9-10's "when it
    // needs you" (the last two drawn by the same `OverrideGroup`). What the
    // grouping is FOR: a dozen radio items after three commands, with no
    // labelled groups, reads as fifteen unrelated things. The reorder pair is
    // grouped for the same reason even though its items are plain commands —
    // "Move up" alone in a flat list says nothing about what it moves through.
    const host = await mountRail();
    const row = host.querySelector<HTMLElement>('.rail-row')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const named = Array.from(menu.querySelectorAll<HTMLElement>('[role="group"]')).map((g) =>
      g.getAttribute('aria-label')
    );
    expect(named).toEqual([
      en.rail.menuOrder,
      en.rail.menuMove,
      en.ladder.policyMenu,
      en.ladder.focusMenu,
    ]);

    // The OverrideGroup assertions below are about OVERRIDE semantics —
    // default-first, default-checked — which neither of the other two labelled
    // sets shares. Move-to-group's checked member is wherever the session IS
    // (and a one-group workspace legitimately offers just two destinations);
    // #559's reorder pair holds plain commands and no radio at all. Both have
    // their own describes; this loop holds the two override sets to their
    // contract.
    const notOverrides: Array<string> = [en.rail.menuMove, en.rail.menuOrder];
    const overrideGroups = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="group"]')
    ).filter((g) => !notOverrides.includes(g.getAttribute('aria-label') ?? ''));
    expect(overrideGroups).toHaveLength(2);
    for (const group of overrideGroups) {
      const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
      // every value plus "follow the default", which must be reachable by the
      // same gesture that left it
      expect(radios.length).toBeGreaterThan(2);
      // EXACTLY one is checked, and with no override set it is the default —
      // a set with none checked, or two, is a radio set that lies
      const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
      expect(checked).toHaveLength(1);
      expect(checked[0]).toBe(radios[0]);
      expect(radios[0].dataset.policyItem ?? radios[0].dataset.focusItem).toBe('default');
    }
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

describe('moving a session between groups from the keyboard (issue 253)', () => {
  /** open the row's menu the way Shift+F10 does — from the row's own button, so
   *  the menu records an anchor to hand focus back to */
  async function openMenuOn(host: HTMLElement, index: number): Promise<HTMLElement> {
    const opener = Array.from(host.querySelectorAll<HTMLElement>('[data-rail-open]'))[index];
    opener.focus();
    await act(async () => {
      opener.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    return opener;
  }

  const moveItems = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-move-item]'));

  it('offers every group you made plus Ungrouped, as one labelled radio set', async () => {
    const host = await mountRail();
    await openMenuOn(host, 2); // "loose one"

    const items = moveItems();
    expect(items.map((i) => i.getAttribute('data-move-item'))).toEqual(['g1', 'ungrouped']);
    for (const i of items) {
      expect(i.tagName).toBe('BUTTON'); // Enter and Space from the platform
      expect(i.getAttribute('role')).toBe('menuitemradio');
    }
    // one choice, announced as one choice — not two loose commands after the
    // three above them
    const set = items[0].closest('[role="group"]')!;
    expect(set.getAttribute('aria-label')).toBe(en.rail.menuMove);
    // and they are inside the ring the menu's arrows already walk
    const walked = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')
    );
    for (const i of items) expect(walked).toContain(i);
  });

  it('checks the group the session is actually in', async () => {
    const host = await mountRail();
    await openMenuOn(host, 0); // "switchboard", in g1
    expect(moveItems().map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false']);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await openMenuOn(host, 2); // "loose one", in nothing
    expect(moveItems().map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });

  it('commits through the same call the drop handler makes', async () => {
    const moves: Array<[string, string | null]> = [];
    const host = await mount(rail({ onMoveToGroup: (c, g) => moves.push([c, g]) }));
    await openMenuOn(host, 2);

    await act(async () => moveItems()[0].click()); // what Enter on a button does
    expect(moves).toEqual([['c3', 'g1']]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('sends a session to Ungrouped, which is what a drop on the rail does', async () => {
    const moves: Array<[string, string | null]> = [];
    const host = await mount(rail({ onMoveToGroup: (c, g) => moves.push([c, g]) }));
    await openMenuOn(host, 0); // "switchboard", in g1

    await act(async () => moveItems()[1].click());
    expect(moves).toEqual([['c1', null]]);
  });

  it('treats "move it where it already is" as a no-op, not a round trip', async () => {
    // the drop handler has exactly this guard; a keyboard path that skipped it
    // would push an identical membership through IPC and reshuffle the grid
    const moves: Array<[string, string | null]> = [];
    const host = await mount(rail({ onMoveToGroup: (c, g) => moves.push([c, g]) }));
    const opener = await openMenuOn(host, 0);

    await act(async () => moveItems()[0].click()); // already in g1
    expect(moves).toEqual([]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(opener); // and it costs you your place
  });

  it('leaves the section out entirely when there is nowhere to move to', async () => {
    const host = await mount(rail({ groups: [], sessions: [sessions[2]] }));
    await openMenuOn(host, 0);
    expect(moveItems()).toHaveLength(0);
    // the rest of the menu is untouched
    expect(
      document.querySelectorAll('[role="menu"] [role^="menuitem"]').length
    ).toBeGreaterThan(3);
  });

  it('never offers an automatic group — its membership is not a choice', async () => {
    // two sessions in one folder cluster on their own (E12-05). Advertising one
    // as a destination would be a command that does nothing, which is exactly
    // what the drop handler refuses to do.
    const folder = 'C:/Projects/shared';
    const host = await mount(
      rail({
        sessions: [
          ...sessions,
          { id: 'c4', title: 'twin a', status: 'idle', folder },
          { id: 'c5', title: 'twin b', status: 'idle', folder },
        ],
      })
    );
    expect(host.querySelector('[data-group-kind="auto"]')).not.toBeNull();
    await openMenuOn(host, 2);
    expect(moveItems().map((i) => i.getAttribute('data-move-item'))).toEqual(['g1', 'ungrouped']);
  });

  it('carries a live region from the first frame, empty until something moves', async () => {
    // one that is INSERTED already holding its text is announced by almost
    // nothing (#222) — so the region has to pre-date the words
    const host = await mountRail();
    const live = host.querySelector<HTMLElement>('[role="status"]');
    expect(live).not.toBeNull();
    expect(live!.textContent).toBe('');
  });

  it('announces the move and puts the keyboard back on the row once it lands', async () => {
    // The move is a round trip: React re-parents the row into the destination
    // card when the answer arrives, so the button the menu was opened from is a
    // detached node by then and focusing IT would strand the keyboard on <body>.
    const host = await mount(rail());
    const opener = await openMenuOn(host, 2); // "loose one"
    await act(async () => moveItems()[0].click()); // -> Work

    // nothing claimed yet: the store hasn't answered
    expect(host.querySelector('[role="status"]')!.textContent).toBe('');

    // the answer lands as new props, and the row is now inside the group
    await act(async () => {
      root!.render(
        rail({ sessions: [sessions[0], sessions[1], { ...sessions[2], groupId: 'g1' }] })
      );
    });

    expect(host.querySelector('[role="status"]')!.textContent).toBe('loose one moved to Work');
    const landed = Array.from(host.querySelectorAll<HTMLElement>('[data-rail-open]')).find(
      (r) => r.getAttribute('data-rail-open') === 'c3'
    )!;
    expect(landed).not.toBe(opener); // it really is a different element
    expect(document.activeElement).toBe(landed);
  });

  it('lands on the destination group when that group is collapsed', async () => {
    // focus() on a display:none element does nothing at all, so a row that
    // moved into a folded group would leave the keyboard nowhere
    const host = await mount(rail());
    const toggle = host.querySelector<HTMLElement>('[data-rail-group-toggle]')!;
    await act(async () => toggle.click()); // fold "Work"
    await openMenuOn(host, 0); // the only row left on screen is "loose one"

    await act(async () => moveItems()[0].click());
    await act(async () => {
      root!.render(
        rail({ sessions: [sessions[0], sessions[1], { ...sessions[2], groupId: 'g1' }] })
      );
    });

    expect(host.querySelector('[role="status"]')!.textContent).toBe('loose one moved to Work');
    const dest = host.querySelector<HTMLElement>('[data-rail-group-toggle]')!;
    expect(document.activeElement).toBe(dest);
    expect(dest.getAttribute('aria-expanded')).toBe('false'); // and says why
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
        queueEvents={[events[0]]}
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

describe('events panel notices (issue 314)', () => {
  // Neither notice is reached by navigating anywhere: both are pushed into a
  // panel already on screen, long after mount — the update one when a dialog
  // closes or a handshake resolves, the reconnect one when a monitor comes
  // back. Without a live region a screen-reader user is simply never told.
  // #260 gave the update notice the pair and left the older reconnect offer
  // alone; #314 closes that gap, so this block reads the contract off BOTH and
  // keeps them one idiom rather than two.
  const live = (host: HTMLElement): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>('[role="status"]'));

  it('announces the reconnect offer, on the message rather than the buttons', async () => {
    const host = await mount(
      <EventsPanel
        sessions={[]}
        events={[]}
        queueEvents={[]}
        visited={new Set<number>()}
        onFocus={noop}
        onVisit={noop}
        queueBinding="Ctrl+Space"
        reconnectOffer
        onRestoreLayout={noop}
        onDismissOffer={noop}
      />
    );
    const regions = live(host);
    expect(regions).toHaveLength(1);
    const [region] = regions;
    expect(region.getAttribute('aria-live')).toBe('polite');
    // the OFFER, not the controls: a region wrapping the buttons would read
    // "Restore Not now" every time the box changed
    expect(region.textContent).toBe(en.events.reconnectOffer);
    expect(region.querySelector('button')).toBeNull();
  });

  for (const kind of ['installed', 'available'] as const) {
    it(`gives the ${kind} update notice the same pair`, async () => {
      const host = await mount(
        <EventsPanel
          sessions={[]}
          events={[]}
          queueEvents={[]}
          visited={new Set<number>()}
          onFocus={noop}
          onVisit={noop}
          queueBinding="Ctrl+Space"
          updateNotice={{ kind, version: '0.2.0' }}
          onUpdateNow={noop}
          onDismissUpdateNotice={noop}
        />
      );
      const regions = live(host);
      expect(regions).toHaveLength(1);
      expect(regions[0].getAttribute('aria-live')).toBe('polite');
      expect(regions[0].textContent).toContain('0.2.0');
      expect(regions[0].querySelector('button')).toBeNull();
    });
  }

  it('says nothing when there is nothing to say', async () => {
    // a live region that is always mounted and always empty is noise waiting
    // to happen; these are conditional, and that is the point
    const host = await mountEvents();
    expect(live(host)).toHaveLength(0);
  });
});

describe('urgency lamps (issue 197)', () => {
  it('are named buttons — one per session, each saying its state', async () => {
    const host = await mount(
      <UrgencyStrip
        sessions={sessions}
        needing={new Set<string>()}
        urgency={new Map<string, number>()}
        activeCardId="c2"
        onFocus={noop}
        onExpire={noop}
        onBeatStart={noop}
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
        needing={new Set<string>()}
        urgency={new Map<string, number>()}
        activeCardId="c2"
        onFocus={noop}
        onExpire={noop}
        onBeatStart={noop}
      />
    );
    const current = host.querySelectorAll('[data-urgency-lamp][aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('data-urgency-lamp')).toBe('c2');
  });
});
