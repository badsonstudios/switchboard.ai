// @vitest-environment jsdom
// The sessions strip across the top (#1143): the line above, and the groups.
//
// Driven through the real `railOrder`, never a hand-built order: the strip's
// whole claim is that it draws from the one derivation the rail and `Ctrl+1..9`
// use, so a test that invented its own grouping would be testing a strip that
// does not exist.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { listStart, SessionsStrip } from './SessionsStrip';
import { sessionSpokenName } from './SessionRow';
import { railOrder } from '../lib/groups';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
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
  /** collapsed or hidden: not on screen until asked for */
  folded?: string[];
  /** card id -> when its post-jump highlight runs out; null is "not painted yet" */
  urgency?: Array<[string, number | null]>;
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
        folded={new Set(world.folded ?? [])}
        urgency={new Map(world.urgency ?? [])}
        groups={world.groups}
        order={railOrder(world.sessions, world.groups, pinned)}
        needing={new Set(world.needing ?? [])}
        pinned={pinned}
        onCreateGroup={noop}
        onNewSession={noop}
        onOpenInGroup={noop}
        onFocus={noop}
        onClose={noop}
        onDiff={noop}
        onRename={noop}
        onTogglePin={noop}
        onMoveToGroup={noop}
        onRenameGroup={noop}
        palette={[]}
        onRecolorGroup={noop}
        policies={DEFAULT_BOOK}
        onCycleGroupPolicy={noop}
        onDeleteGroup={noop}
        onOpenAll={noop}
        onPlace={noop}
        onReorder={noop}
        onMoveGroup={noop}
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
const pill = (host: HTMLElement, id: string): HTMLElement =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-strip-pill]')).find(
    (el) => el.dataset.stripPill === id
  )!;

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
      i18next.t('rail.addSession'),
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

  it('says nothing about sessions it is not showing, because it shows them all', async () => {
    const host = await mount(WORLD);
    expect(host.querySelector('[data-strip-empty]')).toBeNull();
  });
});

describe('sessions that are not in a group', () => {
  it('are pills, after the groups, in the order Ctrl+N counts them', async () => {
    const host = await mount({
      groups: [BACK],
      sessions: [s('loose-a'), s('api', { groupId: BACK.id }), s('loose-b')],
    });
    const row = Array.from(host.querySelectorAll<HTMLElement>('[data-strip-item-need]'));
    expect(row.map((el) => el.dataset.stripGroup ?? el.dataset.stripPill)).toEqual([
      BACK.id,
      'loose-a',
      'loose-b',
    ]);
  });

  it('carry the name, the state word, what it is working on, and the status mark', async () => {
    const host = await mount({ groups: [], sessions: [s('scratch', { taskLabel: 'Sync the skills folder' })] });
    const p = pill(host, 'scratch');
    expect(text(p.querySelector('[data-strip-pill-title]'))).toBe('scratch');
    expect(text(p.querySelector('[data-strip-pill-state]'))).toBe(i18next.t('status.idle'));
    expect(text(p.querySelector('[data-strip-pill-label]'))).toBe('Sync the skills folder');
    // the row's own mark, not a second drawing of it
    expect(p.querySelector('[title]')).not.toBeNull();
  });

  it('hold the second line open with a dash when there is no label yet', async () => {
    const host = await mount({ groups: [], sessions: [s('scratch')] });
    expect(text(pill(host, 'scratch').querySelector('[data-strip-pill-label]'))).toBe('—');
  });

  it('are filled in exactly when counted, whatever the status says', async () => {
    // #1137 at the pill: the total and the pills are read from one set
    const host = await mount({ groups: [], sessions: [s('a'), s('b'), s('c')], needing: ['b'] });
    expect(text(host.querySelector('[data-strip-line] [data-strip-need]'))).toBe('1 needs you');
    expect(['a', 'b', 'c'].map((id) => pill(host, id).dataset.needsYou)).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('go to their session on a click', async () => {
    const focused: string[] = [];
    const host = await mount({ groups: [], sessions: [s('a'), s('b')] }, { onFocus: (id) => focused.push(id) });
    await click(pill(host, 'b'));
    expect(focused).toEqual(['b']);
  });

  it('mark the one the grid is showing', async () => {
    const host = await mount({ groups: [], sessions: [s('a'), s('b')] }, { selectedId: 'a' });
    expect(pill(host, 'a').getAttribute('aria-current')).toBe('true');
    expect(pill(host, 'b').getAttribute('aria-current')).toBeNull();
  });

  it('have a dashed edge when folded away, and say so', async () => {
    const host = await mount({ groups: [], sessions: [s('a'), s('b')], folded: ['b'] });
    expect(pill(host, 'a').dataset.folded).toBe('false');
    expect(pill(host, 'a').getAttribute('style')).toContain('solid');
    expect(pill(host, 'b').dataset.folded).toBe('true');
    expect(pill(host, 'b').getAttribute('style')).toContain('dashed');
    expect(pill(host, 'b').getAttribute('aria-label')).toContain('folded away');
    expect(pill(host, 'b').title).toBe(i18next.t('strip.pillFoldedHint'));
  });

  it('a folded-away pill is brought back by the same click that goes to it', async () => {
    // there is no second gesture: going to a session is what unfolds it
    const focused: string[] = [];
    const host = await mount(
      { groups: [], sessions: [s('a')], folded: ['a'] },
      { onFocus: (id) => focused.push(id) }
    );
    await click(pill(host, 'a'));
    expect(focused).toEqual(['a']);
  });

  it('a folded-away pill that needs you is filled in all the same', async () => {
    const host = await mount({ groups: [], sessions: [s('a')], folded: ['a'], needing: ['a'] });
    expect(pill(host, 'a').dataset.needsYou).toBe('true');
    expect(pill(host, 'a').style.opacity).toBe('1');
  });

  it('show a pin, and pinned ones come first', async () => {
    const host = await mount({ groups: [], sessions: [s('a'), s('b'), s('c')], pinned: ['c'] });
    expect(Array.from(host.querySelectorAll<HTMLElement>('[data-strip-pill]')).map((el) => el.dataset.stripPill)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(pill(host, 'c').dataset.pinned).toBe('true');
  });

  it('are called what a row in the list is called', async () => {
    const host = await mount({ groups: [], sessions: [s('a', { taskLabel: 'Tray icon redraw' })] });
    const session = s('a', { taskLabel: 'Tray icon redraw' });
    expect(pill(host, 'a').getAttribute('aria-label')).toBe(
      sessionSpokenName(i18next.t.bind(i18next), session, false, 0)
    );
  });
});

describe('the highlight after a jump', () => {
  it('lights the pill the jump landed on, and only that one', async () => {
    const host = await mount({ groups: [], sessions: [s('a'), s('b')], urgency: [['b', null]] });
    expect(pill(host, 'a').dataset.flash).toBeUndefined();
    expect(pill(host, 'b').dataset.flash).toBe('true');
  });

  it('lights the GROUP when the session is inside one, and its row if the list is open', async () => {
    const host = await mount({ ...WORLD, urgency: [['worker', null]] });
    expect(entry(host, BACK.id).dataset.flash).toBe('true');
    expect(entry(host, DOCS.id).dataset.flash).toBeUndefined();
    await click(opener(host, BACK.id));
    const rows = Array.from(list(host)!.querySelectorAll<HTMLElement>('.rail-row'));
    expect(rows.map((r) => r.dataset.flash)).toEqual([undefined, 'true', undefined]);
  });

  it('is out once its beat has run out', async () => {
    const host = await mount({ groups: [], sessions: [s('a')], urgency: [['a', Date.now() - 1]] });
    expect(pill(host, 'a').dataset.flash).toBeUndefined();
  });

  it('put away, it draws nothing at all', async () => {
    // …and runs nothing either: the highlight's timing is App's (#1164), so
    // there is no reason for a hidden strip to stay mounted
    const host = await mount({ groups: [], sessions: [s('a')], urgency: [['a', null]] }, { shown: false });
    expect(host.innerHTML).toBe('');
  });

  it('a jump that lands in the open list leaves it open, with the row lit', async () => {
    // the real sequence: the list is open, THEN the jump changes which card
    // the grid is showing. Any other change of card closes the list; this one
    // is the list showing you where you landed.
    const host = await mount(WORLD, { selectedId: 'manual' });
    await click(opener(host, BACK.id));
    await mount({ ...WORLD, urgency: [['worker', null]] }, { selectedId: 'worker' });
    expect(list(host)).not.toBeNull();
    const rows = Array.from(list(host)!.querySelectorAll<HTMLElement>('.rail-row'));
    expect(rows.map((r) => r.dataset.flash)).toEqual([undefined, 'true', undefined]);
  });
});

describe('a folded-away session inside a group', () => {
  it('is counted on the group, since no collapsed row lists it any more', async () => {
    const host = await mount({ ...WORLD, folded: ['api', 'db', 'manual'] });
    expect(text(entry(host, BACK.id).querySelector('[data-strip-group-folded]'))).toBe(
      i18next.t('strip.groupFolded', { count: 2 })
    );
    expect(entry(host, 'auto:C:/proj/PropaneMon').querySelector('[data-strip-group-folded]')).toBeNull();
  });

  it('is marked on its row in the list, in looks and in words', async () => {
    const host = await mount({ ...WORLD, folded: ['worker'] });
    await click(opener(host, BACK.id));
    const rows = Array.from(list(host)!.querySelectorAll<HTMLElement>('.rail-row'));
    expect(rows.map((r) => r.dataset.folded)).toEqual([undefined, 'true', undefined]);
    expect(rows[1].getAttribute('style')).toContain('dashed');
    expect(rows[1].querySelector('[data-rail-open]')!.getAttribute('aria-label')).toContain('folded away');
    expect(rows[0].querySelector('[data-rail-open]')!.getAttribute('aria-label')).not.toContain('folded away');
  });
});

describe('the cell at each end of the row', () => {
  // jsdom lays nothing out, so the boxes are given: the row is 400px wide and
  // every entry is 150px with a 10px gap, in document order.
  function layOut(host: HTMLElement, scrolledBy = 0): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const rect = (left: number, width: number): DOMRect =>
        ({ left, right: left + width, top: 0, bottom: 43, width, height: 43, x: left, y: 0 }) as DOMRect;
      if (this.hasAttribute('data-strip-scroller')) return rect(0, 400);
      const items = Array.from(host.querySelectorAll('[data-strip-item-need]')).filter(
        (el) => el.closest('[data-strip-scroller]') !== null
      );
      const i = items.indexOf(this);
      return i === -1 ? rect(0, 0) : rect(i * 160 - scrolledBy, 150);
    });
  }
  const cell = (host: HTMLElement, side: 'start' | 'end'): HTMLElement | null =>
    host.querySelector<HTMLElement>(`[data-strip-edge="${side}"]`);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not there at all when everything fits', async () => {
    const host = await mount({ groups: [], sessions: [s('a'), s('b')] });
    layOut(host);
    await mount({ groups: [], sessions: [s('a'), s('b')] });
    expect(cell(host, 'start')).toBeNull();
    expect(cell(host, 'end')).toBeNull();
  });

  it('appears at both ends once something is cut off, quiet when nothing off-edge needs you', async () => {
    const world: World = { groups: [], sessions: ['a', 'b', 'c', 'd'].map((id) => s(id)) };
    const host = await mount(world);
    layOut(host);
    await mount(world);
    expect(cell(host, 'end')!.dataset.stripEdgeNeed).toBe('0');
    expect(cell(host, 'end')!.getAttribute('aria-label')).toBe(i18next.t('strip.edgeMore'));
    // nothing is past the start, so that cell is there (the row does not jump
    // sideways when it appears) and inert
    expect(cell(host, 'start')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('turns amber with the number of waiting sessions that are off that end', async () => {
    const world: World = {
      groups: [],
      sessions: ['a', 'b', 'c', 'd', 'e'].map((id) => s(id)),
      needing: ['a', 'd', 'e'],
    };
    const host = await mount(world);
    layOut(host);
    await mount(world);
    // a is on screen; d (480-630) and e (640-790) are past the 400px edge
    expect(cell(host, 'end')!.dataset.stripEdgeNeed).toBe('2');
    expect(text(cell(host, 'end'))).toContain('2');
    expect(cell(host, 'end')!.getAttribute('aria-label')).toBe(i18next.t('strip.edgeNeed', { count: 2 }));
  });

  it('counts a group that is off the edge by its own number', async () => {
    const world: World = {
      groups: [BACK],
      sessions: [
        s('api', { groupId: BACK.id }),
        s('worker', { groupId: BACK.id }),
        s('l1'),
        s('l2'),
        s('l3'),
      ],
      needing: ['api', 'worker'],
    };
    const host = await mount(world);
    // scrolled 300px along: the group (0-150) is now wholly past the start
    layOut(host, 300);
    await mount(world);
    expect(cell(host, 'start')!.dataset.stripEdgeNeed).toBe('2');
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

  it('rows in a list CAN be picked up: a drag reorders the group (#1178)', async () => {
    // This said the opposite until #1178 ("nothing here says what a drag means
    // yet"). It means something now: up and down within the group, which the
    // owner could only do by switching the list to the left and back. What a
    // drag does is held in SessionsStrip.row-drag.test.tsx.
    const host = await mount(WORLD);
    await click(opener(host, BACK.id));
    expect(list(host)!.querySelector<HTMLElement>('.rail-row')!.draggable).toBe(true);
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
