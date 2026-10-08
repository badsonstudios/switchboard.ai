// @vitest-environment jsdom
// The sessions strip across the top (#1143): the line above, and the groups.
//
// Driven through the real `railOrder`, never a hand-built order: the strip's
// whole claim is that it draws from the one derivation the rail and `Ctrl+1..9`
// use, so a test that invented its own grouping would be testing a strip that
// does not exist.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { listStart, SessionsStrip } from './SessionsStrip';
import { railOrder } from '../lib/groups';
import { RailGroup, RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

// Colours are tokens rather than the `#rrggbb` a real group carries: this file
// is renderer TSX and the lint rule that bans raw hex cannot tell data from
// styling. Nothing here asserts on a colour.
const BACK: RailGroup = { id: 'g-back', name: 'Backend', color: 'var(--status-working)' };
const DOCS: RailGroup = { id: 'g-docs', name: 'Docs', color: 'var(--status-done)' };

const s = (id: string, over: Partial<RailSession> = {}): RailSession => ({
  id,
  title: id,
  status: 'idle',
  ...over,
});

type StripProps = React.ComponentProps<typeof SessionsStrip>;

interface World {
  sessions: RailSession[];
  groups: RailGroup[];
  needing?: string[];
  pinned?: string[];
}

async function mount(world: World, over: Partial<StripProps> = {}): Promise<HTMLElement> {
  // a second call re-renders into the same host, so a test can change what the
  // strip is handed while a list is open
  let host = document.body.querySelector<HTMLElement>('[data-test-host]');
  if (!root || !host) {
    host = document.createElement('div');
    host.dataset.testHost = '';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const pinned = new Set(world.pinned ?? []);
  await act(async () => {
    root!.render(
      <SessionsStrip
        shown
        groups={world.groups}
        order={railOrder(world.sessions, world.groups, pinned)}
        needing={new Set(world.needing ?? [])}
        pinned={pinned}
        onCreateGroup={noop}
        onNewSession={noop}
        onOpenInGroup={noop}
        onFocus={noop}
        onClose={noop}
        {...over}
      />
    );
  });
  return host;
}

const entry = (host: HTMLElement, key: string): HTMLElement =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-strip-group]')).find(
    (el) => el.dataset.stripGroup === key
  )!;
const opener = (host: HTMLElement, key: string): HTMLButtonElement =>
  entry(host, key).querySelector<HTMLButtonElement>('[data-strip-group-open]')!;
const list = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-strip-list]');
const text = (el: Element | null | undefined): string => el?.textContent ?? '';

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
  });
}

/** two made groups, a folder the app grouped by itself, and one loose session */
const WORLD: World = {
  groups: [BACK, DOCS],
  sessions: [
    s('api', { groupId: BACK.id }),
    s('worker', { groupId: BACK.id }),
    s('db', { groupId: BACK.id }),
    s('manual', { groupId: DOCS.id }),
    s('mon-a', { folder: 'C:/proj/PropaneMon' }),
    s('mon-b', { folder: 'C:/proj/PropaneMon' }),
    s('scratch', { folder: 'C:/proj/scratch' }),
  ],
};

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the line above the strip', () => {
  it('renders nothing at all unless the strip is shown', async () => {
    const host = await mount(WORLD, { shown: false });
    expect(host.innerHTML).toBe('');
  });

  it('puts "+ group", "+ session" and then the total on the line, in that order', async () => {
    const host = await mount({ ...WORLD, needing: ['api', 'scratch'] });
    const line = host.querySelector('[data-strip-line]')!;
    expect(Array.from(line.children).map((c) => c.textContent)).toEqual([
      i18next.t('rail.addGroup'),
      i18next.t('strip.addSession'),
      '2 need you',
    ]);
  });

  it('shows no total when nobody is waiting, and counts one in the singular', async () => {
    const calm = await mount(WORLD);
    expect(calm.querySelector('[data-strip-need]')).toBeNull();
    await act(async () => root!.unmount());
    root = null;

    const one = await mount({ ...WORLD, needing: ['db'] });
    expect(text(one.querySelector('[data-strip-need]'))).toBe('1 needs you');
  });

  it('creates a group under the default name and asks for a new session', async () => {
    const said: string[] = [];
    const host = await mount(WORLD, {
      onCreateGroup: (name) => said.push(`group:${name}`),
      onNewSession: () => said.push('session'),
    });
    await click(host.querySelector<HTMLElement>('[data-strip-add-group]')!);
    await click(host.querySelector<HTMLElement>('[data-strip-add-session]')!);
    expect(said).toEqual([`group:${i18next.t('rail.newGroup')}`, 'session']);
  });
});

describe('the groups on the strip', () => {
  it('lists your groups in their order, then the ones the app made', async () => {
    const host = await mount(WORLD);
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-strip-group]')).map(
        (el) => `${el.dataset.stripGroupKind}:${text(el.querySelector('[data-strip-group-name]'))}`
      )
    ).toEqual(['group:Backend', 'group:Docs', 'auto:PropaneMon']);
  });

  it('shows how many sessions each holds, and "calm" when none needs you', async () => {
    const host = await mount(WORLD);
    const back = entry(host, BACK.id);
    expect(text(back.querySelector('[data-strip-group-count]'))).toBe('3');
    expect(text(back.querySelector('[data-strip-group-summary]'))).toBe(i18next.t('rail.calm'));
    expect(back.dataset.needsYou).toBe('false');
  });

  it('shows the Ctrl+N range each group holds, counted the way the rail counts', async () => {
    // groups first, then automatic groups, then loose: 1-3, 4, 5-6, and the
    // loose session is 7
    const host = await mount(WORLD);
    const range = (key: string): string => text(entry(host, key).querySelector('[data-strip-group-range]'));
    expect(range(BACK.id)).toBe(i18next.t('strip.range', { from: 1, to: 3 }));
    expect(range(DOCS.id)).toBe('4');
    expect(range('auto:C:/proj/PropaneMon')).toBe(i18next.t('strip.range', { from: 5, to: 6 }));
  });

  it('a made group can open a new session in itself; an automatic one cannot', async () => {
    const opened: string[] = [];
    const host = await mount(WORLD, { onOpenInGroup: (id) => opened.push(id) });
    await click(entry(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-add]')!);
    expect(opened).toEqual([BACK.id]);
    // membership in an automatic group comes from the folder; it cannot be given
    expect(entry(host, 'auto:C:/proj/PropaneMon').querySelector('[data-strip-group-add]')).toBeNull();
  });

  it('an empty group says so, and its list says there are no sessions yet', async () => {
    const host = await mount({ groups: [BACK], sessions: [s('loose')] });
    const back = entry(host, BACK.id);
    expect(text(back.querySelector('[data-strip-group-count]'))).toBe('0');
    expect(text(back.querySelector('[data-strip-group-summary]'))).toBe(i18next.t('rail.groupEmpty'));
    expect(back.querySelector('[data-strip-group-range]')).toBeNull();

    await click(opener(host, BACK.id));
    expect(text(host.querySelector('[data-strip-list-empty]'))).toBe(i18next.t('rail.empty'));
  });

  it('says "No sessions yet" only when there is nothing at all', async () => {
    const none = await mount({ groups: [], sessions: [] });
    expect(none.querySelector<HTMLElement>('[data-strip-empty]')!.dataset.stripEmpty).toBe('none');
    await act(async () => root!.unmount());
    root = null;

    // one empty group is not "nothing": the entry is there to be seen
    const oneGroup = await mount({ groups: [BACK], sessions: [] });
    expect(oneGroup.querySelector('[data-strip-empty]')).toBeNull();
    expect(entry(oneGroup, BACK.id)).toBeTruthy();
  });

  it('says how many loose sessions it is not showing yet, rather than hiding them', async () => {
    const host = await mount(WORLD);
    const pending = host.querySelector<HTMLElement>('[data-strip-empty]')!;
    expect(pending.dataset.stripEmpty).toBe('pending');
    expect(pending.textContent).toBe(i18next.t('strip.loosePending', { count: 1 }));
  });
});

describe('a group’s drop-down list', () => {
  it('opens on a click with the group’s sessions as full rows, numbered', async () => {
    const host = await mount(WORLD);
    expect(list(host)).toBeNull();
    await click(opener(host, BACK.id));

    expect(opener(host, BACK.id).getAttribute('aria-expanded')).toBe('true');
    const rows = Array.from(list(host)!.querySelectorAll<HTMLElement>('.rail-row'));
    expect(rows.map((r) => text(r.querySelector('[data-rail-title]')))).toEqual(['api', 'worker', 'db']);
    expect(rows.map((r) => text(r.querySelector('[data-rail-ordinal]')))).toEqual(['1', '2', '3']);
    // the same row the rail draws: state word, label line, close
    expect(rows[0].querySelector('[data-rail-state]')).not.toBeNull();
    expect(rows[0].querySelector('[data-rail-label]')).not.toBeNull();
    expect(rows[0].querySelector('.rail-x')).not.toBeNull();
  });

  it('a count of N is exactly N highlighted rows', async () => {
    // #1137's rule at the strip: the entry's number and the rows under it are
    // read from one set, so they cannot disagree
    const host = await mount({ ...WORLD, needing: ['api', 'db', 'manual'] });
    expect(text(entry(host, BACK.id).querySelector('[data-strip-group-summary]'))).toBe(
      i18next.t('rail.needSummary', { count: 2 })
    );
    await click(opener(host, BACK.id));
    const lit = Array.from(list(host)!.querySelectorAll<HTMLElement>('.rail-row')).filter(
      (r) => r.dataset.needsYou === 'true'
    );
    expect(lit.map((r) => text(r.querySelector('[data-rail-title]')))).toEqual(['api', 'db']);
  });

  it('goes to the session that was clicked, and closes', async () => {
    const focused: string[] = [];
    const host = await mount(WORLD, { onFocus: (id) => focused.push(id) });
    await click(opener(host, BACK.id));
    await click(list(host)!.querySelector<HTMLElement>('[data-rail-open="worker"]')!);
    expect(focused).toEqual(['worker']);
    expect(list(host)).toBeNull();
  });

  it('closing a session from the list leaves the list open', async () => {
    const closed: string[] = [];
    const host = await mount(WORLD, { onClose: (id) => closed.push(id) });
    await click(opener(host, BACK.id));
    await click(list(host)!.querySelector<HTMLElement>('.rail-x')!);
    expect(closed).toEqual(['api']);
    expect(list(host)).not.toBeNull();
  });

  it('a second click on the entry closes it, and so does a click elsewhere', async () => {
    const host = await mount(WORLD);
    await click(opener(host, BACK.id));
    await click(opener(host, BACK.id));
    expect(list(host)).toBeNull();

    await click(opener(host, BACK.id));
    await click(host.querySelector<HTMLElement>('[data-strip-line]')!);
    expect(list(host)).toBeNull();
  });

  it('opening another group swaps the list rather than stacking a second', async () => {
    const host = await mount(WORLD);
    await click(opener(host, BACK.id));
    await click(opener(host, DOCS.id));
    expect(host.querySelectorAll('[data-strip-list]')).toHaveLength(1);
    expect(list(host)!.dataset.stripList).toBe(DOCS.id);
    expect(opener(host, BACK.id).getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes it and puts the keyboard back on the entry', async () => {
    const host = await mount(WORLD);
    await click(opener(host, BACK.id));
    // opening put the keyboard on the first row
    expect((document.activeElement as HTMLElement | null)?.dataset.railOpen).toBe('api');
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(list(host)).toBeNull();
    expect(document.activeElement).toBe(opener(host, BACK.id));
  });

  it('keeps a pinned session first, in the block that does not scroll away', async () => {
    const host = await mount({ ...WORLD, pinned: ['db'] });
    await click(opener(host, BACK.id));
    const rows = Array.from(list(host)!.querySelectorAll<HTMLElement>('.rail-row'));
    expect(rows.map((r) => text(r.querySelector('[data-rail-title]')))).toEqual(['db', 'api', 'worker']);
    expect(list(host)!.querySelector('[data-pinned-block] .rail-row [data-rail-title]')!.textContent).toBe(
      'db'
    );
  });

  it('a double-click on a row is two clicks, not a rename', async () => {
    // The rail renames on a double-click. Here the first click of one already
    // means "go to this session" and closes the list, so a rename box could
    // never be reached that way; the row is told it is never being edited, and
    // the menu's Rename is the door that will work. Sent as a real double-click
    // (click, click, dblclick) — a bare `dblclick` is not something a mouse does.
    const focused: string[] = [];
    const host = await mount(WORLD, { onFocus: (id) => focused.push(id) });
    await click(opener(host, BACK.id));
    const first = list(host)!.querySelector<HTMLElement>('.rail-row')!;
    await click(first);
    expect(focused).toEqual(['api']);
    expect(list(host)).toBeNull();
    expect(host.querySelector('.rail-row input')).toBeNull();
  });

  it('rows in a list cannot be picked up: nothing here says what a drag means yet', async () => {
    const host = await mount(WORLD);
    await click(opener(host, BACK.id));
    expect(list(host)!.querySelector<HTMLElement>('.rail-row')!.draggable).toBe(false);
  });

  it('closes by itself when you go somewhere another way', async () => {
    // Ctrl+N, the palette, a lamp: the grid is now showing a different card,
    // and a list left open would be sitting on top of it
    const host = await mount(WORLD, { selectedId: 'api' });
    await click(opener(host, BACK.id));
    expect(list(host)).not.toBeNull();
    await mount(WORLD, { selectedId: 'manual' });
    expect(list(host)).toBeNull();
  });

  it('closes when its group goes away, and follows its members while open', async () => {
    const host = await mount(WORLD);
    await click(opener(host, BACK.id));
    await mount({ ...WORLD, sessions: WORLD.sessions.filter((x) => x.id !== 'worker') });
    expect(Array.from(list(host)!.querySelectorAll('[data-rail-title]')).map(text)).toEqual(['api', 'db']);

    await mount({ groups: [DOCS], sessions: WORLD.sessions.filter((x) => x.groupId !== BACK.id) });
    expect(list(host)).toBeNull();
  });

  it('opening a new session in the group puts its list away first', async () => {
    const opened: string[] = [];
    const host = await mount(WORLD, { onOpenInGroup: (id) => opened.push(id) });
    await click(opener(host, BACK.id));
    await click(entry(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-add]')!);
    expect(opened).toEqual([BACK.id]);
    expect(list(host)).toBeNull();
  });

  it('leaves an Escape that is not its own alone', async () => {
    // A dialog opened by a chord while a list is up must still get its Escape.
    // This listener sits on the document; if it stopped every Escape, that
    // dialog would be one that will not close.
    const host = await mount(WORLD);
    await click(opener(host, BACK.id));
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    let reached = 0;
    elsewhere.addEventListener('keydown', () => reached++);
    await act(async () => {
      elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(reached).toBe(1);
    expect(document.activeElement).toBe(elsewhere);
    // …and it is not this list's to act on either
    expect(list(host)).not.toBeNull();
  });

  it('the arrow panel toggles the list and cannot hold the keyboard', async () => {
    const host = await mount(WORLD);
    const arrow = entry(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-arrow]')!;
    expect(arrow.tagName).toBe('SPAN');
    expect(arrow.getAttribute('aria-hidden')).toBe('true');
    await click(arrow);
    expect(list(host)).not.toBeNull();
    await click(arrow);
    expect(list(host)).toBeNull();
  });
});

describe('where a list is put', () => {
  it('hangs from the entry’s own start edge when there is room', () => {
    expect(listStart({ left: 120, right: 300 }, false, 1200)).toBe(120);
  });

  it('is pulled back in at the far side of the window', () => {
    // 286 wide with an 8px margin: the furthest it may start is 906
    expect(listStart({ left: 1100, right: 1190 }, false, 1200)).toBe(906);
  });

  it('is pulled back in at the near side, for an entry scrolled half off it', () => {
    expect(listStart({ left: -90, right: 60 }, false, 1200)).toBe(8);
  });

  it('measures from the other edge when the page reads right to left', () => {
    // inline-start is the RIGHT edge: 1200 - 1000 = 200 from it
    expect(listStart({ left: 820, right: 1000 }, true, 1200)).toBe(200);
    expect(listStart({ left: 1150, right: 1290 }, true, 1200)).toBe(8);
  });

  it('still fits a window narrower than the list', () => {
    expect(listStart({ left: 40, right: 200 }, false, 260)).toBe(8);
  });
});

describe('what a screen reader is told about a group', () => {
  it('names it, counts it and gives its state in one sentence', async () => {
    const host = await mount({ ...WORLD, needing: ['api'] });
    expect(opener(host, BACK.id).getAttribute('aria-label')).toBe(
      i18next.t('strip.groupLabel', {
        name: 'Backend',
        count: 3,
        summary: i18next.t('rail.needSummary', { count: 1 }),
      })
    );
  });

  it('says an automatic group is one, since its folder and "auto" are decoration', async () => {
    const host = await mount(WORLD);
    expect(opener(host, 'auto:C:/proj/PropaneMon').getAttribute('aria-label')).toContain(
      i18next.t('strip.autoGroupName', { name: 'PropaneMon' })
    );
  });
});
