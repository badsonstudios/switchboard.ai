// @vitest-environment jsdom
// Dragging a session up and down INSIDE its group's list on the strip (#1178).
//
// The owner, with the sessions across the top: "I can't move a session up or
// down in a group to relocate it. I have to move the session window to the
// left and then move it there." A row in a group's open list did not drag at
// all; the keyboard chord was the only way.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsStrip } from './SessionsStrip';
import { railOrder } from '../lib/groups';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DND_TYPE } from '../lib/rail-dnd';
import { setDraggedCard } from '../lib/drag-context';
import { edgeAtY } from '../lib/strip-drag';
import { RailGroup, RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};
// tokens, not hexes: this is renderer TSX and the raw-colour lint cannot tell
// data from styling
const A: RailGroup = { id: 'g-a', name: 'Alpha', color: 'var(--status-working)' };
const B: RailGroup = { id: 'g-b', name: 'Beta', color: 'var(--status-done)' };

const s = (id: string, over: Partial<RailSession> = {}): RailSession => ({
  id,
  title: id,
  status: 'idle',
  ...over,
});

/** three in Alpha, one in Beta, one loose */
const SESSIONS: RailSession[] = [
  s('a1', { groupId: A.id }),
  s('a2', { groupId: A.id }),
  s('a3', { groupId: A.id }),
  s('b1', { groupId: B.id }),
  s('loose', { folder: 'C:/proj/loose' }),
];

type StripProps = React.ComponentProps<typeof SessionsStrip>;

async function mount(
  over: Partial<StripProps> = {},
  pinnedIds: string[] = []
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const groups = [A, B];
  const pinned = new Set(pinnedIds);
  await act(async () => {
    root!.render(
      <SessionsStrip
        shown
        folded={new Set()}
        urgency={new Map()}
        groups={groups}
        order={railOrder(SESSIONS, groups, pinned)}
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
        palette={['var(--status-working)']}
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

const by = (sel: string, attr: string, want: string): HTMLElement =>
  Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
    (el) => el.getAttribute(attr) === want
  )!;
const groupBox = (key: string): HTMLElement => by('[data-strip-group]', 'data-strip-group', key);
const list = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-strip-list]');
/** a row in the open list, by its session */
const row = (id: string): HTMLElement =>
  list()!.querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!.closest<HTMLElement>('.rail-row')!;

async function openList(groupId: string): Promise<void> {
  await act(async () => {
    by('[data-strip-group-open]', 'data-strip-group-open', groupId).click();
  });
  expect(list()).not.toBeNull();
}

/** every row is 40px tall starting at y=100: "top half" and "bottom half" are
 *  then facts the test states, not accidents of layout */
const TOP = 105;
const BOTTOM = 135;
const boxed = (el: HTMLElement): HTMLElement => {
  el.getBoundingClientRect = () =>
    ({ left: 0, right: 250, top: 100, bottom: 140, width: 250, height: 40 }) as DOMRect;
  return el;
};

function transfer(type: string, payload: string): object {
  return {
    setData: noop,
    getData: (t: string) => (t === type ? payload : ''),
    types: [type],
    effectAllowed: '',
    dropEffect: '',
  };
}
async function fire(
  el: HTMLElement,
  type: string,
  dataTransfer: object,
  clientY = 0
): Promise<MouseEvent> {
  const ev = Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientY }), {
    dataTransfer,
  });
  await act(async () => {
    el.dispatchEvent(ev);
  });
  return ev;
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  setDraggedCard(null);
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('which half of a row the pointer is in', () => {
  it('the top half is "before" it, the bottom half "after"', () => {
    const box = { top: 100, bottom: 140 };
    expect(edgeAtY(box, 101)).toBe('before');
    expect(edgeAtY(box, 119)).toBe('before');
    expect(edgeAtY(box, 121)).toBe('after');
    expect(edgeAtY(box, 139)).toBe('after');
  });
});

describe('a row in a group’s open list (issue 1178)', () => {
  it('can be picked up: it is draggable, where it was not', async () => {
    await mount();
    await openList(A.id);
    for (const id of ['a1', 'a2', 'a3']) expect(row(id).draggable).toBe(true);
  });

  it('⭐ dropped on the TOP half of another row, lands above it', async () => {
    const reorders: unknown[] = [];
    await mount({ onReorder: (...a) => reorders.push(a) });
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a3');
    await fire(row('a3'), 'dragstart', dt);

    const over = await fire(boxed(row('a1')), 'dragover', dt, TOP);
    expect(over.defaultPrevented).toBe(true); // it may be dropped here
    // the line says where it will land
    expect(row('a1').dataset.dropEdge).toBe('before');
    expect(row('a1').querySelector('[data-drop-line="before"]')).not.toBeNull();

    await fire(row('a1'), 'drop', dt, TOP);
    expect(reorders).toEqual([[A.id, ['a3', 'a1', 'a2']]]);
  });

  it('dropped on the BOTTOM half, lands below it', async () => {
    const reorders: unknown[] = [];
    await mount({ onReorder: (...a) => reorders.push(a) });
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a1');
    await fire(row('a1'), 'dragstart', dt);
    await fire(boxed(row('a3')), 'dragover', dt, BOTTOM);
    expect(row('a3').dataset.dropEdge).toBe('after');
    await fire(row('a3'), 'drop', dt, BOTTOM);
    expect(reorders).toEqual([[A.id, ['a2', 'a3', 'a1']]]);
  });

  it('a drop that would change nothing draws no line and writes nothing', async () => {
    const reorders: unknown[] = [];
    await mount({ onReorder: (...a) => reorders.push(a) });
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a1');
    await fire(row('a1'), 'dragstart', dt);
    // just below itself's upper neighbour is where it already is
    const over = await fire(boxed(row('a2')), 'dragover', dt, TOP);
    expect(over.defaultPrevented).toBe(false);
    expect(row('a2').dataset.dropEdge).toBeUndefined();
    await fire(row('a2'), 'drop', dt, TOP);
    expect(reorders).toEqual([]);
  });

  it('a pinned session is still not passed: the order settles under it', async () => {
    const reorders: Array<[string, string[]]> = [];
    await mount({ onReorder: (key, ids) => reorders.push([key, ids]) }, ['a1']);
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a3');
    await fire(row('a3'), 'dragstart', dt);
    await fire(boxed(row('a1')), 'dragover', dt, TOP);
    await fire(row('a1'), 'drop', dt, TOP);
    // aimed ABOVE the pinned one, it settles just under it: the pin stays first
    expect(reorders).toEqual([[A.id, ['a1', 'a3', 'a2']]]);
  });

  it('the list is still open after the drop: you can do it again', async () => {
    await mount();
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a3');
    await fire(row('a3'), 'dragstart', dt);
    await fire(boxed(row('a1')), 'dragover', dt, TOP);
    await fire(row('a1'), 'drop', dt, TOP);
    expect(list()).not.toBeNull();
    // and the line is gone
    expect(list()!.querySelector('[data-drop-line]')).toBeNull();
  });

  it('⚠️ letting go ON the line, in the gap between two rows, still drops (found in review)', async () => {
    // the 2px between rows belongs to the list, not to a row, and it is where
    // the line is drawn: the most natural place to let go was a drop on nothing
    const reorders: unknown[] = [];
    await mount({ onReorder: (...a) => reorders.push(a) });
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a3');
    await fire(row('a3'), 'dragstart', dt);
    await fire(boxed(row('a1')), 'dragover', dt, TOP);
    expect(row('a1').dataset.dropEdge).toBe('before');

    // now the pointer is over the list itself, with the line still showing
    const over = await fire(list()!, 'dragover', dt);
    expect(over.defaultPrevented).toBe(true);
    await fire(list()!, 'drop', dt);
    expect(reorders).toEqual([[A.id, ['a3', 'a1', 'a2']]]);
  });

  it('the list takes no drop when no line is showing', async () => {
    const reorders: unknown[] = [];
    await mount({ onReorder: (...a) => reorders.push(a) });
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a3');
    await fire(row('a3'), 'dragstart', dt);
    const over = await fire(list()!, 'dragover', dt);
    expect(over.defaultPrevented).toBe(false);
    await fire(list()!, 'drop', dt);
    expect(reorders).toEqual([]);
  });

  it('a drop on a row is counted once, not again by the list around it', async () => {
    const reorders: unknown[] = [];
    await mount({ onReorder: (...a) => reorders.push(a) });
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a3');
    await fire(row('a3'), 'dragstart', dt);
    await fire(boxed(row('a1')), 'dragover', dt, TOP);
    // the drop bubbles from the row up through the list
    await fire(row('a1'), 'drop', dt, TOP);
    expect(reorders).toHaveLength(1);
  });

  it('leaving the list takes the line with it', async () => {
    await mount();
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a3');
    await fire(row('a3'), 'dragstart', dt);
    await fire(boxed(row('a1')), 'dragover', dt, TOP);
    expect(list()!.querySelector('[data-drop-line]')).not.toBeNull();
    await fire(list()!, 'dragleave', dt);
    expect(list()!.querySelector('[data-drop-line]')).toBeNull();
  });

  it('a drop on a row does not also move the session into a group', async () => {
    const moves: unknown[] = [];
    const reorders: unknown[] = [];
    await mount({ onMoveToGroup: (...a) => moves.push(a), onReorder: (...a) => reorders.push(a) });
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a3');
    await fire(row('a3'), 'dragstart', dt);
    await fire(boxed(row('a1')), 'dragover', dt, TOP);
    await fire(row('a1'), 'drop', dt, TOP);
    expect(reorders).toHaveLength(1);
    expect(moves).toEqual([]);
  });

  it('something that is not one of this strip’s sessions, dragged over a row, is not a reorder', async () => {
    const reorders: unknown[] = [];
    await mount({ onReorder: (...a) => reorders.push(a) });
    await openList(A.id);
    // a file from the desktop, say: no card type on it
    const dt = transfer('Files', 'x');
    const over = await fire(boxed(row('a1')), 'dragover', dt, TOP);
    expect(over.defaultPrevented).toBe(false);
    await fire(row('a1'), 'drop', dt, TOP);
    expect(reorders).toEqual([]);
  });

  it('a row can be dragged onto ANOTHER group’s box to move it there', async () => {
    // not new behaviour, but new reach: it is how a pill joins a group, and a
    // row now carries the same card type
    const moves: unknown[] = [];
    await mount({ onMoveToGroup: (...a) => moves.push(a) });
    await openList(A.id);
    const dt = transfer(DND_TYPE, 'a2');
    await fire(row('a2'), 'dragstart', dt);
    const target = groupBox(B.id);
    await fire(target, 'dragover', dt);
    await fire(target, 'drop', dt);
    expect(moves).toEqual([['a2', B.id]]);
  });
});
