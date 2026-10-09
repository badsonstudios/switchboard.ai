// @vitest-environment jsdom
// Dragging on the sessions strip (#1143).
//
// Three drags: a group sideways, a pill sideways, and a pill onto a group. The
// claims worth pinning are the ones a drag can get wrong quietly: that the line
// is only ever drawn where a drop would really do something, that the drop does
// what the line said, and that a drag of one kind is never read as the other.
//
// jsdom has no drag machinery, so the events are synthesized — as in the rail's
// own reorder tests — and each entry's box is stated rather than laid out.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsStrip } from './SessionsStrip';
import { railOrder } from '../lib/groups';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DND_TYPE, GROUP_DND_TYPE } from '../lib/rail-dnd';
import { setDraggedCard } from '../lib/drag-context';
import { RailGroup, RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

// Tokens, not `#rrggbb`: see SessionsStrip.test.tsx for why.
const A: RailGroup = { id: 'g-a', name: 'Alpha', color: 'var(--status-working)' };
const B: RailGroup = { id: 'g-b', name: 'Beta', color: 'var(--status-done)' };
const C: RailGroup = { id: 'g-c', name: 'Gamma', color: 'var(--status-idle)' };

const s = (id: string, over: Partial<RailSession> = {}): RailSession => ({
  id,
  title: id,
  status: 'idle',
  ...over,
});

/** three groups, a folder the app grouped, and four loose sessions */
const SESSIONS: RailSession[] = [
  s('in-a', { groupId: A.id }),
  s('in-b', { groupId: B.id }),
  s('mon-1', { folder: 'C:/proj/Mon' }),
  s('mon-2', { folder: 'C:/proj/Mon' }),
  s('p1', { folder: 'C:/proj/p1' }),
  s('p2', { folder: 'C:/proj/p2' }),
  s('p3', { folder: 'C:/proj/p3' }),
  s('p4', { folder: 'C:/proj/p4' }),
];
const AUTO = 'auto:C:/proj/Mon';

type StripProps = React.ComponentProps<typeof SessionsStrip>;

async function mount(
  over: Partial<StripProps> = {},
  sessions: RailSession[] = SESSIONS,
  pinnedIds: string[] = []
): Promise<HTMLElement> {
  let host = document.body.querySelector<HTMLElement>('[data-test-host]');
  if (!root || !host) {
    host = document.createElement('div');
    host.dataset.testHost = '';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const groups = [A, B, C];
  const pinned = new Set(pinnedIds);
  await act(async () => {
    root!.render(
      <SessionsStrip
        shown
        folded={new Set()}
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

const by = (host: HTMLElement, sel: string, attr: string, want: string): HTMLElement =>
  Array.from(host.querySelectorAll<HTMLElement>(sel)).find((el) => el.getAttribute(attr) === want)!;
const pill = (host: HTMLElement, id: string): HTMLElement =>
  by(host, '[data-strip-pill]', 'data-strip-pill', id);
const group = (host: HTMLElement, key: string): HTMLElement =>
  by(host, '[data-strip-group]', 'data-strip-group', key);

/** every target is 200px wide starting at x=1000: "left half" and "right half"
 *  are then facts the test states, not accidents of layout */
const LEFT = 1050;
const RIGHT = 1150;
const boxed = (el: HTMLElement): HTMLElement => {
  el.getBoundingClientRect = () =>
    ({ left: 1000, right: 1200, top: 0, bottom: 43, width: 200, height: 43 }) as DOMRect;
  return el;
};

function transfer(type: string, payload: string): object {
  return {
    setData: noop,
    // Chromium's protected mode: the payload is unreadable until the drop
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
  clientX = 0
): Promise<MouseEvent> {
  const ev = Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), {
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

describe('dragging a group sideways', () => {
  it('only a group you made can be picked up', async () => {
    const host = await mount();
    expect(group(host, A.id).draggable).toBe(true);
    // an automatic group sits where its folder puts it
    expect(group(host, AUTO).draggable).toBe(false);
  });

  it('shows a line on the side it would land, and lands there', async () => {
    const moves: Array<[string, string | null]> = [];
    const host = await mount({ onMoveGroup: (id, before) => moves.push([id, before]) });
    const dt = transfer(GROUP_DND_TYPE, A.id);
    await fire(group(host, A.id), 'dragstart', dt);

    // over the RIGHT half of Gamma: Alpha would go after it, to the end
    const over = await fire(boxed(group(host, C.id)), 'dragover', dt, RIGHT);
    expect(over.defaultPrevented).toBe(true);
    expect(group(host, C.id).dataset.dropEdge).toBe('after');
    expect(group(host, C.id).querySelector('[data-drop-line="after"]')).not.toBeNull();

    await fire(group(host, C.id), 'drop', dt, RIGHT);
    expect(moves).toEqual([[A.id, null]]);
    // the line goes with the drag
    expect(host.querySelector('[data-drop-line]')).toBeNull();
  });

  it('lands before the one it is dropped on the left half of', async () => {
    const moves: Array<[string, string | null]> = [];
    const host = await mount({ onMoveGroup: (id, before) => moves.push([id, before]) });
    const dt = transfer(GROUP_DND_TYPE, C.id);
    await fire(group(host, C.id), 'dragstart', dt);
    await fire(boxed(group(host, A.id)), 'dragover', dt, LEFT);
    expect(group(host, A.id).dataset.dropEdge).toBe('before');
    await fire(group(host, A.id), 'drop', dt, LEFT);
    expect(moves).toEqual([[C.id, A.id]]);
  });

  it('draws no line, and offers no drop, where it would change nothing', async () => {
    // Alpha is first; "before Beta" is where it already is
    const moves: Array<[string, string | null]> = [];
    const host = await mount({ onMoveGroup: (id, before) => moves.push([id, before]) });
    const dt = transfer(GROUP_DND_TYPE, A.id);
    await fire(group(host, A.id), 'dragstart', dt);
    const over = await fire(boxed(group(host, B.id)), 'dragover', dt, LEFT);
    expect(over.defaultPrevented).toBe(false);
    expect(host.querySelector('[data-drop-line]')).toBeNull();
    await fire(group(host, B.id), 'drop', dt, LEFT);
    expect(moves).toEqual([]);
  });

  it('cannot be dropped among the automatic groups, or on a pill', async () => {
    const said: string[] = [];
    const host = await mount({
      onMoveGroup: () => said.push('group'),
      onReorder: () => said.push('reorder'),
      onMoveToGroup: () => said.push('join'),
    });
    const dt = transfer(GROUP_DND_TYPE, A.id);
    await fire(group(host, A.id), 'dragstart', dt);
    for (const target of [group(host, AUTO), pill(host, 'p2')]) {
      const over = await fire(boxed(target), 'dragover', dt, RIGHT);
      expect(over.defaultPrevented).toBe(false);
      await fire(target, 'drop', dt, RIGHT);
    }
    expect(said).toEqual([]);
    expect(host.querySelector('[data-drop-line]')).toBeNull();
  });
});

describe('dragging a pill sideways', () => {
  it('shows a line on the side it would land, and hands back the whole new order', async () => {
    const orders: Array<[string, string[]]> = [];
    const host = await mount({ onReorder: (bucket, ids) => orders.push([bucket, ids]) });
    const dt = transfer(DND_TYPE, 'p1');
    await fire(pill(host, 'p1'), 'dragstart', dt);

    const over = await fire(boxed(pill(host, 'p3')), 'dragover', dt, RIGHT);
    expect(over.defaultPrevented).toBe(true);
    expect(pill(host, 'p3').dataset.dropEdge).toBe('after');
    expect(pill(host, 'p3').querySelector('[data-drop-line="after"]')).not.toBeNull();

    await fire(pill(host, 'p3'), 'drop', dt, RIGHT);
    expect(orders).toEqual([['ungrouped', ['p2', 'p3', 'p1', 'p4']]]);
  });

  it('draws no line beside its own neighbour, where it already is', async () => {
    const orders: unknown[] = [];
    const host = await mount({ onReorder: (...a) => orders.push(a) });
    const dt = transfer(DND_TYPE, 'p2');
    await fire(pill(host, 'p2'), 'dragstart', dt);
    const over = await fire(boxed(pill(host, 'p1')), 'dragover', dt, RIGHT); // after p1: unchanged
    expect(over.defaultPrevented).toBe(false);
    expect(host.querySelector('[data-drop-line]')).toBeNull();
    await fire(pill(host, 'p1'), 'drop', dt, RIGHT);
    expect(orders).toEqual([]);
  });

  it('settles against a pinned pill rather than going past it', async () => {
    // p1 is pinned, so it is first. Dropping p4 before it cannot put p4 ahead of
    // a pin: the furthest it goes is straight after it.
    const orders: Array<[string, string[]]> = [];
    const host = await mount({ onReorder: (bucket, ids) => orders.push([bucket, ids]) }, SESSIONS, ['p1']);
    const dt = transfer(DND_TYPE, 'p4');
    await fire(pill(host, 'p4'), 'dragstart', dt);
    await fire(boxed(pill(host, 'p1')), 'dragover', dt, LEFT);
    await fire(pill(host, 'p1'), 'drop', dt, LEFT);
    expect(orders).toEqual([['ungrouped', ['p1', 'p4', 'p2', 'p3']]]);
  });

  it('the line moves with the pointer and leaves when the pointer does', async () => {
    const host = await mount();
    const dt = transfer(DND_TYPE, 'p1');
    await fire(pill(host, 'p1'), 'dragstart', dt);
    await fire(boxed(pill(host, 'p3')), 'dragover', dt, RIGHT);
    await fire(boxed(pill(host, 'p4')), 'dragover', dt, RIGHT);
    // (jsdom fires no dragleave of its own; the next target claiming the line is
    // what a real pointer moving on does too)
    expect(host.querySelectorAll('[data-drop-line]')).toHaveLength(1);
    expect(pill(host, 'p4').dataset.dropEdge).toBe('after');

    await fire(pill(host, 'p4'), 'dragleave', dt);
    expect(host.querySelector('[data-drop-line]')).toBeNull();
  });

  it('a drag that is abandoned leaves nothing behind', async () => {
    const host = await mount();
    const dt = transfer(DND_TYPE, 'p1');
    await fire(pill(host, 'p1'), 'dragstart', dt);
    await fire(boxed(pill(host, 'p3')), 'dragover', dt, RIGHT);
    await fire(pill(host, 'p1'), 'dragend', dt);
    expect(host.querySelector('[data-drop-line]')).toBeNull();
    expect(host.querySelector('[data-drop-into]')).toBeNull();
  });
});

describe('dragging a pill onto a group', () => {
  it('lights the group, and puts the session in it', async () => {
    const joins: Array<[string, string | null]> = [];
    const host = await mount({ onMoveToGroup: (id, gid) => joins.push([id, gid]) });
    const dt = transfer(DND_TYPE, 'p2');
    await fire(pill(host, 'p2'), 'dragstart', dt);

    const over = await fire(boxed(group(host, B.id)), 'dragover', dt, LEFT);
    expect(over.defaultPrevented).toBe(true);
    expect(group(host, B.id).dataset.dropInto).toBe('true');
    // joining is not a reorder: no insertion line on the group
    expect(host.querySelector('[data-drop-line]')).toBeNull();

    await fire(group(host, B.id), 'drop', dt, LEFT);
    expect(joins).toEqual([['p2', B.id]]);
    expect(host.querySelector('[data-drop-into]')).toBeNull();
  });

  it('an automatic group does not light up and takes nothing', async () => {
    // its membership is the folder's; a target that lights up and then does
    // nothing is the thing to avoid
    const joins: unknown[] = [];
    const host = await mount({ onMoveToGroup: (...a) => joins.push(a) });
    const dt = transfer(DND_TYPE, 'p2');
    await fire(pill(host, 'p2'), 'dragstart', dt);
    const over = await fire(boxed(group(host, AUTO)), 'dragover', dt, LEFT);
    expect(over.defaultPrevented).toBe(false);
    expect(group(host, AUTO).dataset.dropInto).toBeUndefined();
    await fire(group(host, AUTO), 'drop', dt, LEFT);
    expect(joins).toEqual([]);
  });

  it('a session that never started cannot join a group', async () => {
    const joins: unknown[] = [];
    const host = await mount(
      { onMoveToGroup: (...a) => joins.push(a) },
      [...SESSIONS, s('dud', { status: 'not-started', folder: 'C:/proj/dud' })]
    );
    const dt = transfer(DND_TYPE, 'dud');
    await fire(pill(host, 'dud'), 'dragstart', dt);
    const over = await fire(boxed(group(host, A.id)), 'dragover', dt, LEFT);
    expect(over.defaultPrevented).toBe(false);
    await fire(group(host, A.id), 'drop', dt, LEFT);
    expect(joins).toEqual([]);
  });

  it('takes a card’s tab dragged up from the workspace, too', async () => {
    // the workspace publishes what it is dragging through `drag-context`, not
    // through the transfer: the group has to read both, as the rail's does
    const joins: Array<[string, string | null]> = [];
    const host = await mount({ onMoveToGroup: (id, gid) => joins.push([id, gid]) });
    setDraggedCard('p3');
    const dt = transfer('text/plain', '');
    const over = await fire(boxed(group(host, C.id)), 'dragover', dt, LEFT);
    expect(over.defaultPrevented).toBe(true);
    await fire(group(host, C.id), 'drop', dt, LEFT);
    expect(joins).toEqual([['p3', C.id]]);
  });

  it('a session already in the group is not offered it again', async () => {
    const joins: unknown[] = [];
    const host = await mount({ onMoveToGroup: (...a) => joins.push(a) });
    setDraggedCard('in-a');
    const dt = transfer('text/plain', '');
    const over = await fire(boxed(group(host, A.id)), 'dragover', dt, LEFT);
    expect(over.defaultPrevented).toBe(false);
    await fire(group(host, A.id), 'drop', dt, LEFT);
    expect(joins).toEqual([]);
  });
});

describe('a drag that ends where the strip cannot see it', () => {
  it('is not remembered: the next drag is the next drag', async () => {
    // p2 is picked up, and then its pill is gone — a second session opened in
    // its folder and the app grouped the two. `dragend` goes to the element the
    // drag started on, which no longer exists, so the pill's own handler never
    // runs. If the strip went on believing p2 was in flight, the tab dragged up
    // from the workspace next would put P2 in the group it was dropped on.
    const joins: Array<[string, string | null]> = [];
    const over: Partial<StripProps> = { onMoveToGroup: (id, gid) => joins.push([id, gid]) };
    const host = await mount(over);
    await fire(pill(host, 'p2'), 'dragstart', transfer(DND_TYPE, 'p2'));
    await mount(over, [...SESSIONS, s('p2-twin', { folder: 'C:/proj/p2' })]);
    // the drag ends somewhere — the window hears it wherever that is
    await act(async () => {
      window.dispatchEvent(new Event('dragend'));
    });

    setDraggedCard('p3');
    const tab = transfer('text/plain', '');
    await fire(boxed(group(host, C.id)), 'dragover', tab, LEFT);
    await fire(group(host, C.id), 'drop', tab, LEFT);
    expect(joins).toEqual([['p3', C.id]]);
  });

  it('and even un-ended, a drag that is not ours is never taken for the last one that was', async () => {
    // the belt to the braces above: the ref is believed only for a drag that
    // carries the strip's own type
    const joins: Array<[string, string | null]> = [];
    const orders: unknown[] = [];
    const host = await mount({
      onMoveToGroup: (id, gid) => joins.push([id, gid]),
      onReorder: (...a) => orders.push(a),
    });
    await fire(pill(host, 'p1'), 'dragstart', transfer(DND_TYPE, 'p1')); // …and never ended

    setDraggedCard('p4');
    const tab = transfer('text/plain', '');
    // over a pill: a workspace tab is not a reorder, and p1 must not be moved
    const overPill = await fire(boxed(pill(host, 'p3')), 'dragover', tab, RIGHT);
    expect(overPill.defaultPrevented).toBe(false);
    expect(host.querySelector('[data-drop-line]')).toBeNull();
    await fire(pill(host, 'p3'), 'drop', tab, RIGHT);
    expect(orders).toEqual([]);
    // onto a group: it is p4 that joins
    setDraggedCard('p4');
    await fire(boxed(group(host, A.id)), 'dragover', tab, LEFT);
    await fire(group(host, A.id), 'drop', tab, LEFT);
    expect(joins).toEqual([['p4', A.id]]);
  });
});

describe('what else a drag touches', () => {
  it('picking a group up closes its list, which hung from where the group was', async () => {
    const host = await mount();
    await act(async () => {
      group(host, A.id).querySelector<HTMLElement>('[data-strip-group-open]')!.click();
    });
    expect(host.querySelector('[data-strip-list]')).not.toBeNull();
    await fire(group(host, A.id), 'dragstart', transfer(GROUP_DND_TYPE, A.id));
    expect(host.querySelector('[data-strip-list]')).toBeNull();
  });

  it('a lone group cannot be picked up: it has nowhere to go', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const solo = createRoot(host);
    const groups = [A];
    const sessions = [s('in-a', { groupId: A.id })];
    await act(async () => {
      solo.render(
        <SessionsStrip
          shown
          folded={new Set()}
          urgency={new Map()}
          groups={groups}
          order={railOrder(sessions, groups, new Set())}
          needing={new Set()}
          pinned={new Set()}
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
        />
      );
    });
    expect(group(host, A.id).draggable).toBe(false);
    await act(async () => solo.unmount());
  });
});

describe('moving a group without a mouse', () => {
  const chord = (key: string): KeyboardEvent =>
    new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  const opener = (host: HTMLElement, id: string): HTMLElement =>
    group(host, id).querySelector<HTMLElement>('[data-strip-group-open]')!;

  it('Ctrl+Alt+Right moves the focused group one place later, Left one earlier', async () => {
    // The menus have no ordering items, by design. But order that can ONLY be
    // changed with a pointer is order some people cannot change, so a group has
    // a chord, as a session already does.
    const moves: Array<[string, string | null]> = [];
    const host = await mount({ onMoveGroup: (id, before) => moves.push([id, before]) });
    const later = chord('ArrowRight');
    await act(async () => {
      opener(host, A.id).dispatchEvent(later);
    });
    expect(later.defaultPrevented).toBe(true);
    // Alpha, Beta, Gamma: one place later is "before Gamma"
    expect(moves).toEqual([[A.id, C.id]]);

    await act(async () => {
      opener(host, C.id).dispatchEvent(chord('ArrowLeft'));
    });
    expect(moves).toEqual([
      [A.id, C.id],
      [C.id, B.id],
    ]);
  });

  it('does nothing at the end of the row, and nothing without the chord', async () => {
    const moves: unknown[] = [];
    const host = await mount({ onMoveGroup: (...a) => moves.push(a) });
    await act(async () => {
      opener(host, A.id).dispatchEvent(chord('ArrowLeft')); // already first
      opener(host, C.id).dispatchEvent(chord('ArrowRight')); // already last
      opener(host, B.id).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      );
    });
    expect(moves).toEqual([]);
  });

  it('an automatic group has no such chord: it does not move', async () => {
    const moves: unknown[] = [];
    const host = await mount({ onMoveGroup: (...a) => moves.push(a) });
    const key = chord('ArrowRight');
    await act(async () => {
      opener(host, AUTO).dispatchEvent(key);
    });
    expect(key.defaultPrevented).toBe(false);
    expect(moves).toEqual([]);
    expect(opener(host, AUTO).getAttribute('aria-keyshortcuts')).toBeNull();
  });
});
