// @vitest-environment jsdom
// The sessions strip's right-click menus (#1143).
//
// Three menus, one per thing you can right-click: a session (its pill, or its
// row in an open list), a group, and an empty part of the strip. There is no
// menu icon anywhere, so these ARE the way to rename, pin, move, close and
// delete from the strip — which is why this file checks what each item does and
// to WHICH session or group, and not only that the items are listed.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsStrip } from './SessionsStrip';
import { railOrder } from '../lib/groups';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { RailGroup, RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

// Tokens, not `#rrggbb`: see SessionsStrip.test.tsx for why.
const BACK: RailGroup = { id: 'g-back', name: 'Backend', color: 'var(--status-working)' };
const DOCS: RailGroup = { id: 'g-docs', name: 'Docs', color: 'var(--status-done)' };
const PALETTE = ['var(--status-working)', 'var(--status-done)', 'var(--status-idle)'];

const s = (id: string, over: Partial<RailSession> = {}): RailSession => ({
  id,
  title: id,
  status: 'idle',
  ...over,
});

/** two groups, one automatic folder group, and two loose sessions */
const SESSIONS: RailSession[] = [
  s('api', { groupId: BACK.id }),
  s('worker', { groupId: BACK.id }),
  s('manual', { groupId: DOCS.id }),
  s('mon-a', { folder: 'C:/proj/PropaneMon' }),
  s('mon-b', { folder: 'C:/proj/PropaneMon' }),
  s('scratch', { folder: 'C:/proj/scratch' }),
  s('notes', { folder: 'C:/proj/notes' }),
];

type StripProps = React.ComponentProps<typeof SessionsStrip>;

async function mount(
  over: Partial<StripProps> = {},
  sessions: RailSession[] = SESSIONS,
  pinnedIds: string[] = [],
  foldedIds: string[] = []
): Promise<HTMLElement> {
  let host = document.body.querySelector<HTMLElement>('[data-test-host]');
  if (!root || !host) {
    host = document.createElement('div');
    host.dataset.testHost = '';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const groups = [BACK, DOCS];
  const pinned = new Set(pinnedIds);
  await act(async () => {
    root!.render(
      <SessionsStrip
        shown
        folded={new Set(foldedIds)}
        urgency={new Map()}
        groups={groups}
        order={railOrder(sessions, groups, pinned)}
        needing={new Set()}
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
        palette={PALETTE}
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

const by = (host: HTMLElement, sel: string, attr: string, want: string): HTMLElement =>
  Array.from(host.querySelectorAll<HTMLElement>(sel)).find((el) => el.getAttribute(attr) === want)!;
const pill = (host: HTMLElement, id: string): HTMLElement =>
  by(host, '[data-strip-pill]', 'data-strip-pill', id);
const group = (host: HTMLElement, key: string): HTMLElement =>
  by(host, '[data-strip-group]', 'data-strip-group', key);
const menu = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-testid="strip-menu"]');
const items = (host: HTMLElement): HTMLElement[] =>
  Array.from(menu(host)?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
const item = (host: HTMLElement, id: string): HTMLElement =>
  by(host, '[data-group-menu-item]', 'data-group-menu-item', id);
const labels = (host: HTMLElement): string[] => items(host).map((el) => el.textContent ?? '');

async function rightClick(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
    );
  });
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
  });
}
async function type(field: HTMLInputElement, text: string): Promise<void> {
  // through the prototype setter: assigning `.value` skips React's value tracker
  const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  await act(async () => {
    valueProp.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

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

describe('right-click on a session', () => {
  it('lists the session’s actions, then the groups it could move to, and nothing about order', async () => {
    const host = await mount();
    await rightClick(pill(host, 'scratch'));
    // (the tick on the choice in force is decoration; `aria-checked` says it)
    expect(labels(host).map((l) => l.replace('✓', ''))).toEqual([
      i18next.t('rail.menuDiff'),
      i18next.t('rail.menuRename'),
      i18next.t('rail.menuPin'),
      i18next.t('rail.menuClose'),
      'Backend',
      'Docs',
      i18next.t('strip.menuNoGroup'),
    ]);
    expect(menu(host)!.querySelector('[data-menu-heading]')!.textContent).toBe(
      i18next.t('rail.menuMove')
    );
    // order is by dragging: no "Move up" / "Move down" here
    expect(menu(host)!.textContent).not.toContain(i18next.t('rail.menuMoveUp'));
    expect(menu(host)!.getAttribute('aria-label')).toBe(
      i18next.t('rail.menuLabel', { title: 'scratch' })
    );
  });

  it('checks the group the session is in now: none, for a loose one', async () => {
    const host = await mount();
    await rightClick(pill(host, 'scratch'));
    expect(item(host, 'move:none').getAttribute('aria-checked')).toBe('true');
    expect(item(host, `move:${BACK.id}`).getAttribute('aria-checked')).toBe('false');
  });

  it('Close session closes THAT session, and no other', async () => {
    const closed: string[] = [];
    const host = await mount({ onClose: (id) => closed.push(id) });
    await rightClick(pill(host, 'notes'));
    await click(item(host, 'close'));
    expect(closed).toEqual(['notes']);
    expect(menu(host)).toBeNull();
  });

  it('the menu follows the session it was opened on, not the one opened before', async () => {
    const closed: string[] = [];
    const host = await mount({ onClose: (id) => closed.push(id) });
    await rightClick(pill(host, 'scratch'));
    await rightClick(pill(host, 'notes'));
    expect(host.querySelectorAll('[data-testid="strip-menu"]')).toHaveLength(1);
    await click(item(host, 'close'));
    expect(closed).toEqual(['notes']);
  });

  it('opens changes, and pins — and offers Unpin for one already pinned', async () => {
    const said: string[] = [];
    const host = await mount(
      {
        onDiff: (x) => said.push(`diff:${x.id}`),
        onTogglePin: (id) => said.push(`pin:${id}`),
      },
      SESSIONS,
      ['notes']
    );
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'diff'));
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'pin'));
    expect(said).toEqual(['diff:scratch', 'pin:scratch']);

    await rightClick(pill(host, 'notes'));
    expect(item(host, 'pin').textContent).toBe(i18next.t('rail.menuUnpin'));
  });

  it('moves it into a group, and out of every group', async () => {
    const moves: Array<[string, string | null]> = [];
    const host = await mount({ onMoveToGroup: (id, gid) => moves.push([id, gid]) });
    await rightClick(pill(host, 'scratch'));
    await click(item(host, `move:${DOCS.id}`));
    expect(moves).toEqual([['scratch', DOCS.id]]);

    // from a row in an open list, the other way
    await click(group(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-open]')!);
    const row = host.querySelector<HTMLElement>('[data-strip-list] .rail-row')!;
    await rightClick(row);
    expect(item(host, `move:${BACK.id}`).getAttribute('aria-checked')).toBe('true');
    await click(item(host, 'move:none'));
    expect(moves).toEqual([
      ['scratch', DOCS.id],
      ['api', null],
    ]);
  });

  it('choosing the group it is already in does nothing', async () => {
    const moves: Array<[string, string | null]> = [];
    const host = await mount({ onMoveToGroup: (id, gid) => moves.push([id, gid]) });
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'move:none'));
    expect(moves).toEqual([]);
  });

  it('dims Rename and Move for a session that never started, and they do nothing', async () => {
    // main has no record of such a card, and declines both writes: an item that
    // is offered and then silently does nothing is the thing to avoid
    const said: string[] = [];
    const host = await mount(
      { onMoveToGroup: () => said.push('move'), onRename: () => said.push('rename') },
      [...SESSIONS, s('dud', { status: 'not-started', folder: 'C:/proj/dud' })]
    );
    await rightClick(pill(host, 'dud'));
    expect(item(host, 'rename').getAttribute('aria-disabled')).toBe('true');
    expect(item(host, `move:${BACK.id}`).getAttribute('aria-disabled')).toBe('true');
    await click(item(host, 'rename'));
    await click(item(host, `move:${BACK.id}`));
    expect(said).toEqual([]);
    expect(host.querySelector('[data-strip-rename]')).toBeNull();
    // closing one is still allowed
    expect(item(host, 'close').getAttribute('aria-disabled')).toBe('false');
  });

  it('Escape closes the menu and puts the keyboard back on the pill', async () => {
    const host = await mount();
    await rightClick(pill(host, 'scratch'));
    await press(items(host)[0], 'Escape');
    expect(menu(host)).toBeNull();
    expect(document.activeElement).toBe(pill(host, 'scratch'));
  });
});

describe('renaming a session from the menu', () => {
  it('a pill is replaced by a box holding its name; Enter commits it trimmed', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mount({ onRename: (id, name) => renames.push([id, name]) });
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'rename'));

    const box = host.querySelector<HTMLElement>('[data-strip-rename="scratch"]')!;
    const field = box.querySelector<HTMLInputElement>('input')!;
    expect(field.value).toBe('scratch');
    await type(field, '  scratchpad  ');
    await press(field, 'Enter');
    expect(renames).toEqual([['scratch', 'scratchpad']]);
    expect(host.querySelector('[data-strip-rename]')).toBeNull();
    expect(pill(host, 'scratch')).toBeTruthy();
  });

  it('a blank name is not a rename, and Escape leaves the name that was there', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mount({ onRename: (id, name) => renames.push([id, name]) });
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'rename'));
    let field = host.querySelector<HTMLInputElement>('[data-strip-rename] input')!;
    await type(field, '   ');
    await press(field, 'Enter');
    expect(renames).toEqual([]);
    expect(host.querySelector('[data-strip-rename]')).toBeNull();

    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'rename'));
    field = host.querySelector<HTMLInputElement>('[data-strip-rename] input')!;
    await type(field, 'never mind');
    await press(field, 'Escape');
    expect(renames).toEqual([]);
    expect(host.querySelector('[data-strip-rename]')).toBeNull();
  });

  it('a row in an open list is renamed in place, and its list stays open', async () => {
    // the door a double-click cannot be here: the first click of one goes to
    // the session and closes the list
    const renames: Array<[string, string]> = [];
    const host = await mount({ onRename: (id, name) => renames.push([id, name]) });
    await click(group(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-open]')!);
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-strip-list] .rail-row'));
    await rightClick(rows[1]);
    await click(item(host, 'rename'));

    expect(host.querySelector('[data-strip-list]')).not.toBeNull();
    const field = host.querySelector<HTMLInputElement>('[data-strip-list] .rail-row input')!;
    expect(field.value).toBe('worker');
    await type(field, 'queue');
    await press(field, 'Enter');
    expect(renames).toEqual([['worker', 'queue']]);
    expect(host.querySelector('[data-strip-list]')).not.toBeNull();
    expect(host.querySelector('[data-strip-list] .rail-row input')).toBeNull();
  });

  it('Escape in a row’s rename box ends the edit and leaves the list open', async () => {
    const host = await mount();
    await click(group(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-open]')!);
    await rightClick(host.querySelector<HTMLElement>('[data-strip-list] .rail-row')!);
    await click(item(host, 'rename'));
    const field = host.querySelector<HTMLInputElement>('[data-strip-list] .rail-row input')!;
    await press(field, 'Escape');
    expect(host.querySelector('[data-strip-list] .rail-row input')).toBeNull();
    expect(host.querySelector('[data-strip-list]')).not.toBeNull();
  });
});

describe('right-click on a group', () => {
  it('lists the group’s actions, and nothing about order', async () => {
    const host = await mount();
    await rightClick(group(host, BACK.id));
    expect(items(host).map((el) => el.getAttribute('data-group-menu-item'))).toEqual([
      'new',
      'open-all',
      'rename',
      'recolor',
      'policy',
      'delete',
    ]);
    expect(menu(host)!.textContent).not.toContain(i18next.t('rail.groupMoveUp'));
    expect(menu(host)!.getAttribute('aria-label')).toBe(
      i18next.t('rail.groupMenuLabel', { name: 'Backend' })
    );
  });

  it('each action reaches THAT group', async () => {
    const said: string[] = [];
    const over: Partial<StripProps> = {
      onOpenInGroup: (id) => said.push(`new:${id}`),
      onOpenAll: (ids) => said.push(`open:${ids.join(',')}`),
      onRecolorGroup: (id, color) => said.push(`colour:${id}:${color}`),
      onCycleGroupPolicy: (id) => said.push(`policy:${id}`),
      onDeleteGroup: (id) => said.push(`delete:${id}`),
    };
    const host = await mount(over, SESSIONS, [], ['manual']);
    for (const id of ['new', 'open-all', 'recolor', 'policy', 'delete']) {
      await rightClick(group(host, DOCS.id));
      await click(item(host, id));
    }
    expect(said).toEqual([
      `new:${DOCS.id}`,
      'open:manual',
      // Docs is the second colour, so "Change colour" takes it to the third
      `colour:${DOCS.id}:${PALETTE[2]}`,
      `policy:${DOCS.id}`,
      `delete:${DOCS.id}`,
    ]);
  });

  it('Rename group puts a box where the group was; Enter commits it', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mount({ onRenameGroup: (id, name) => renames.push([id, name]) });
    await rightClick(group(host, BACK.id));
    await click(item(host, 'rename'));
    const field = host.querySelector<HTMLInputElement>(`[data-strip-rename="${BACK.id}"] input`)!;
    expect(field.value).toBe('Backend');
    await type(field, 'Services');
    await press(field, 'Enter');
    expect(renames).toEqual([[BACK.id, 'Services']]);
    expect(group(host, BACK.id)).toBeTruthy();
  });

  it('says how the group shows its sessions, in the same words the rail uses', async () => {
    const host = await mount();
    await rightClick(group(host, BACK.id));
    expect(item(host, 'policy').textContent).toBe(
      i18next.t('strip.menuGroupPolicy', { policy: i18next.t('policy.groupDefault') })
    );
  });

  it('an automatic group can only be opened: there is nothing of it to rename or delete', async () => {
    const opened: string[] = [];
    const host = await mount(
      { onOpenAll: (ids) => opened.push(ids.join(',')) },
      SESSIONS,
      [],
      ['mon-a', 'mon-b']
    );
    await rightClick(group(host, 'auto:C:/proj/PropaneMon'));
    expect(items(host).map((el) => el.getAttribute('data-group-menu-item'))).toEqual(['open-all']);
    await click(item(host, 'open-all'));
    expect(opened).toEqual(['mon-a,mon-b']);
  });

  it('Open all brings back only what is folded away, and is dimmed when nothing is', async () => {
    // a session on screen, or behind a tab you can see, is not something to
    // "open": asking the grid to expand a tabbed card pulls it out of its stack
    const opened: string[] = [];
    const over: Partial<StripProps> = { onOpenAll: (ids) => opened.push(ids.join(',')) };
    const host = await mount(over, SESSIONS, [], ['worker']);
    await rightClick(group(host, BACK.id));
    await click(item(host, 'open-all'));
    expect(opened).toEqual(['worker']);

    await mount(over, SESSIONS, [], []);
    await rightClick(group(host, BACK.id));
    expect(item(host, 'open-all').getAttribute('aria-disabled')).toBe('true');
    await click(item(host, 'open-all'));
    expect(opened).toEqual(['worker']);
  });
});

describe('right-click on an empty part of the strip', () => {
  it('offers where the sessions are listed, and the two "new" buttons', async () => {
    const host = await mount();
    await rightClick(host.querySelector<HTMLElement>('[data-strip-scroller]')!);
    expect(labels(host).map((l) => l.replace('✓', ''))).toEqual([
      i18next.t('strip.menuPlaceLeft'),
      i18next.t('strip.menuPlaceTop'),
      i18next.t('strip.menuNewGroup'),
      i18next.t('strip.menuNewSession'),
    ]);
    // the placement in force is the checked one
    expect(item(host, 'place:top').getAttribute('aria-checked')).toBe('true');
    expect(item(host, 'place:left').getAttribute('aria-checked')).toBe('false');
  });

  it('moves the list to the left, makes a group, opens a session', async () => {
    const said: string[] = [];
    const host = await mount({
      onPlace: (p) => said.push(`place:${p}`),
      onCreateGroup: (name) => said.push(`group:${name}`),
      onNewSession: () => said.push('session'),
    });
    const line = host.querySelector<HTMLElement>('[data-strip-line]')!;
    for (const id of ['place:left', 'new-group', 'new-session']) {
      // the line above the row counts as an empty part of the strip too
      await rightClick(line);
      await click(item(host, id));
    }
    expect(said).toEqual(['place:left', `group:${i18next.t('rail.newGroup')}`, 'session']);
  });

  it('a right-click on a pill or a group is THEIR menu, never this one as well', async () => {
    const host = await mount();
    await rightClick(pill(host, 'scratch'));
    expect(host.querySelectorAll('[data-testid="strip-menu"]')).toHaveLength(1);
    expect(item(host, 'close')).toBeTruthy();
    await rightClick(group(host, BACK.id));
    expect(host.querySelectorAll('[data-testid="strip-menu"]')).toHaveLength(1);
    expect(item(host, 'delete')).toBeTruthy();
  });
});

describe('a right-click is only a right-click', () => {
  it('does not also go to the session, on a pill or on a row', async () => {
    const focused: string[] = [];
    const host = await mount({ onFocus: (id) => focused.push(id) });
    await rightClick(pill(host, 'scratch'));
    await click(group(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-open]')!);
    await rightClick(host.querySelector<HTMLElement>('[data-strip-list] .rail-row')!);
    expect(focused).toEqual([]);
    // …and the list the row is in is still open under its menu
    expect(host.querySelector('[data-strip-list]')).not.toBeNull();
  });

  it('inside a rename box it is left to the edit menu', async () => {
    // a text box owes its user Cut / Copy / Paste before it owes anyone ours
    const host = await mount();
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'rename'));
    const field = host.querySelector<HTMLInputElement>('[data-strip-rename] input')!;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    await act(async () => {
      field.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(menu(host)).toBeNull();
  });

  it('on an open list’s own heading it opens nothing, rather than the strip’s menu over the list', async () => {
    const host = await mount();
    await click(group(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-open]')!);
    await rightClick(host.querySelector<HTMLElement>('[data-strip-list-head]')!);
    expect(menu(host)).toBeNull();
  });
});

describe('nothing outlives what it was about', () => {
  it('a menu is dropped when its session goes, and does not come back with it', async () => {
    const host = await mount();
    await rightClick(pill(host, 'scratch'));
    expect(menu(host)).not.toBeNull();
    await mount({}, SESSIONS.filter((x) => x.id !== 'scratch'));
    expect(menu(host)).toBeNull();
    // the session is back (or one with its id is): the old menu must not be
    await mount();
    expect(menu(host)).toBeNull();
  });

  it('a rename box is dropped when its pill stops being a pill, and stays dropped', async () => {
    // nobody did anything: a second session opened in the same folder, and the
    // app grouped the two. Kept, the box would reappear with the keyboard in it
    // the moment the session was loose again — in the middle of other typing.
    const renames: Array<[string, string]> = [];
    const host = await mount({ onRename: (id, name) => renames.push([id, name]) });
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'rename'));
    expect(host.querySelector('[data-strip-rename]')).not.toBeNull();

    const twin = s('scratch-2', { folder: 'C:/proj/scratch' });
    await mount({ onRename: (id, name) => renames.push([id, name]) }, [...SESSIONS, twin]);
    expect(host.querySelector('[data-strip-rename]')).toBeNull();

    await mount({ onRename: (id, name) => renames.push([id, name]) });
    expect(host.querySelector('[data-strip-rename]')).toBeNull();
    expect(pill(host, 'scratch')).toBeTruthy();
    expect(renames).toEqual([]);
  });

  it('a row’s rename box goes with its list, and is not waiting when the list reopens', async () => {
    const host = await mount();
    const opener = group(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-open]')!;
    await click(opener);
    await rightClick(host.querySelector<HTMLElement>('[data-strip-list] .rail-row')!);
    await click(item(host, 'rename'));
    expect(host.querySelector('[data-strip-list] .rail-row input')).not.toBeNull();

    await click(host.querySelector<HTMLElement>('[data-strip-line]')!); // away: the list closes
    expect(host.querySelector('[data-strip-list]')).toBeNull();
    await click(opener);
    expect(host.querySelector('[data-strip-list] .rail-row input')).toBeNull();
  });

  it('clicking away from a rename box keeps the old name', async () => {
    const renames: Array<[string, string]> = [];
    const host = await mount({ onRename: (id, name) => renames.push([id, name]) });
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'rename'));
    const field = host.querySelector<HTMLInputElement>('[data-strip-rename] input')!;
    await type(field, 'half a name');
    await act(async () => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(renames).toEqual([]);
    expect(host.querySelector('[data-strip-rename]')).toBeNull();
  });
});

describe('the keyboard goes back to what was acted on', () => {
  it('after a pin, which re-sorts the pills under it', async () => {
    const host = await mount();
    await rightClick(pill(host, 'notes'));
    await click(item(host, 'pin'));
    // the pin lands: the pill is now first, a different element in a new place
    await mount({}, SESSIONS, ['notes']);
    expect(document.activeElement).toBe(pill(host, 'notes'));
  });

  it('after a rename ends', async () => {
    const host = await mount();
    await rightClick(pill(host, 'scratch'));
    await click(item(host, 'rename'));
    await press(host.querySelector<HTMLInputElement>('[data-strip-rename] input')!, 'Escape');
    expect(document.activeElement).toBe(pill(host, 'scratch'));
  });

  it('to the group, after changing its colour', async () => {
    const host = await mount();
    await rightClick(group(host, BACK.id));
    await click(item(host, 'recolor'));
    await mount();
    expect(document.activeElement).toBe(group(host, BACK.id).querySelector('[data-strip-group-open]'));
  });

  it('Enter in a rename box is consumed, so it cannot also press what gets the keyboard next', async () => {
    // Found in the real app: renaming a group opened its list. Ending the edit
    // hands the keyboard to the group's button while Enter is still going
    // down, and a real browser then "clicks" a button that is focused when
    // the keypress completes. jsdom does not synthesize that click, so what
    // can be pinned here is the cause: the keydown must be cancelled.
    const host = await mount();
    const enter = (): KeyboardEvent =>
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    await rightClick(group(host, BACK.id));
    await click(item(host, 'rename'));
    const groupKey = enter();
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-strip-rename] input')!.dispatchEvent(groupKey);
    });
    expect(groupKey.defaultPrevented).toBe(true);
    // …and the list did not open
    expect(host.querySelector('[data-strip-list]')).toBeNull();

    // the same for a row in a list, where the "click" would mean "go to this
    // session" and close the list
    await click(group(host, BACK.id).querySelector<HTMLElement>('[data-strip-group-open]')!);
    await rightClick(host.querySelector<HTMLElement>('[data-strip-list] .rail-row')!);
    await click(item(host, 'rename'));
    const rowKey = enter();
    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-strip-list] .rail-row input')!.dispatchEvent(rowKey);
    });
    expect(rowKey.defaultPrevented).toBe(true);
  });

  it('but not when the menu was dismissed by clicking somewhere else', async () => {
    // the click chose where the keyboard goes; taking it back would be rude
    const host = await mount();
    await rightClick(pill(host, 'scratch'));
    const elsewhere = host.querySelector<HTMLElement>('[data-strip-add-session]')!;
    elsewhere.focus();
    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(menu(host)).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});
