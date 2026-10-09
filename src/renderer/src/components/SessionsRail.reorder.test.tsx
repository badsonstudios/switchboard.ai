// @vitest-environment jsdom
// #559 — dragging a session up and down inside its group, and the keyboard
// path that has to exist beside it (§5.32's fifth rule: a drag is never the
// only way to do something).
//
// The ORDER MODEL is lib/rail-order's and is tested there. This file owns what
// only a mounted rail can answer: that a drop lands where the insertion line
// said it would, that a cross-group drag still means what E12-04 made it mean,
// and that the menu offers a real move and refuses an impossible one.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { SessionsRail } from './SessionsRail';
import { RailGroup, RailSession } from '../model/types';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { ManualOrder, NO_ORDER } from '../lib/rail-order';
import { initI18nForTests } from '../i18n/test-i18n';
import { uiDelete } from '../lib/ui-state';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};

let host: HTMLDivElement;
let root: Root;

/**
 * A group under test.
 *
 * The color is a TOKEN rather than the `#rrggbb` a real group carries: group
 * colors are main-owned persisted DATA, but this file is renderer TSX and the
 * lint rule that bans raw hex there does not know the difference. Nothing here
 * asserts on the color.
 */
const backend: RailGroup = { id: 'g1', name: 'Backend', color: 'var(--status-working)' };
const infra: RailGroup = { id: 'g2', name: 'Infra', color: 'var(--status-idle)' };

const session = (id: string, groupId?: string): RailSession => ({
  id,
  title: id,
  status: 'idle',
  // a folder each, so nothing emergently auto-groups underneath the test
  folder: `C:\\p\\${id}`,
  groupId,
});

interface Mounted {
  reorder: ReturnType<typeof vi.fn>;
  move: ReturnType<typeof vi.fn>;
}

async function mount(opts: {
  sessions: RailSession[];
  groups?: RailGroup[];
  pinned?: string[];
  manualOrder?: ManualOrder;
}): Promise<Mounted> {
  const reorder = vi.fn();
  const move = vi.fn();
  await act(async () => {
    root.render(
      <SessionsRail
        sessions={opts.sessions}
        groups={opts.groups ?? []}
        needing={new Set<string>()}
        palette={['var(--status-working)']}
        selectedId={null}
        policies={DEFAULT_BOOK}
        pinned={new Set(opts.pinned ?? [])}
        manualOrder={opts.manualOrder ?? NO_ORDER}
        onReorder={reorder}
        onRename={noop}
        onFocus={noop}
        onDiff={noop}
        onClose={noop}
        onCreateGroup={noop}
        onRenameGroup={noop}
        onRecolorGroup={noop}
        onDeleteGroup={noop}
        onOpenInGroup={noop}
        onMoveToGroup={move}
        onTogglePin={noop}
        onCycleGroupPolicy={noop}
      />
    );
  });
  return { reorder, move };
}

/** the rail's order, top to bottom — the list Ctrl+1..9 counts against */
const painted = (): string[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-rail-open]')).map(
    (el) => el.getAttribute('data-rail-open') ?? ''
  );

const rowOf = (id: string): HTMLElement =>
  host
    .querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!
    .closest<HTMLElement>('.rail-row')!;

/**
 * Drag `from` onto `to` and release on the given half of it.
 *
 * jsdom has no drag machinery, so the events are synthesized — which is the
 * point: the handlers have to work from `clientY` against the row's own box,
 * and `getBoundingClientRect` is stubbed per row so "above the middle" is a
 * fact the test states rather than a coincidence of layout.
 */
async function drag(from: string, to: string, half: 'top' | 'bottom'): Promise<void> {
  const src = rowOf(from);
  const dst = rowOf(to);
  dst.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140 }) as DOMRect;
  const clientY = half === 'top' ? 110 : 130;
  const dataTransfer = {
    setData: noop,
    getData: () => from,
    types: ['application/x-switchboard-card'],
    effectAllowed: '',
  };
  await act(async () => {
    src.dispatchEvent(
      Object.assign(new MouseEvent('dragstart', { bubbles: true }), { dataTransfer })
    );
  });
  await act(async () => {
    dst.dispatchEvent(
      Object.assign(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY }), {
        dataTransfer,
      })
    );
  });
  await act(async () => {
    dst.dispatchEvent(
      Object.assign(new MouseEvent('drop', { bubbles: true, cancelable: true, clientY }), {
        dataTransfer,
      })
    );
  });
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // the rail persists its collapsed set and width through the ui blob; a
  // leftover from another file's mount would collapse the group under test
  uiDelete(['railCollapsed', 'railWidth']);
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = undefined as unknown as Root;
    await act(async () => r.unmount());
  }
  host.remove();
});

describe('reordering a group by dragging (#559)', () => {
  it('paints a group in the order the user arranged, not the order it arrived', async () => {
    await mount({
      sessions: [session('a', 'g1'), session('b', 'g1'), session('c', 'g1')],
      groups: [backend],
      manualOrder: new Map([['g1', ['c', 'a', 'b']]]),
    });
    expect(painted()).toEqual(['c', 'a', 'b']);
  });

  it('a drop on the TOP half of a row lands the session above it', async () => {
    const m = await mount({
      sessions: [session('a', 'g1'), session('b', 'g1'), session('c', 'g1')],
      groups: [backend],
    });
    await drag('c', 'a', 'top');
    expect(m.reorder).toHaveBeenCalledWith('g1', ['c', 'a', 'b']);
    // ...and it is a REORDER, not a membership change wearing one's coat
    expect(m.move).not.toHaveBeenCalled();
  });

  it('a drop on the BOTTOM half lands it below', async () => {
    const m = await mount({
      sessions: [session('a', 'g1'), session('b', 'g1'), session('c', 'g1')],
      groups: [backend],
    });
    await drag('a', 'b', 'bottom');
    expect(m.reorder).toHaveBeenCalledWith('g1', ['b', 'a', 'c']);
  });

  it('draws the insertion line on the row and side the drop will use', async () => {
    await mount({
      sessions: [session('a', 'g1'), session('b', 'g1'), session('c', 'g1')],
      groups: [backend],
    });
    const src = rowOf('c');
    const dst = rowOf('a');
    dst.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140 }) as DOMRect;
    const dataTransfer = { setData: noop, getData: () => 'c', types: [], effectAllowed: '' };
    await act(async () => {
      src.dispatchEvent(
        Object.assign(new MouseEvent('dragstart', { bubbles: true }), { dataTransfer })
      );
    });
    await act(async () => {
      dst.dispatchEvent(
        Object.assign(
          new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 105 }),
          { dataTransfer }
        )
      );
    });
    expect(dst.getAttribute('data-drop-edge')).toBe('before');
    expect(dst.querySelector('[data-drop-line="before"]')).not.toBeNull();
  });

  it('offers NO line, and no reorder, for a drop that would change nothing', async () => {
    const m = await mount({
      sessions: [session('a', 'g1'), session('b', 'g1')],
      groups: [backend],
    });
    // `a` dropped above `a` is the same list back
    await drag('a', 'a', 'top');
    expect(m.reorder).not.toHaveBeenCalled();
    expect(host.querySelector('[data-drop-line]')).toBeNull();
  });

  it('leaves a drag from ANOTHER group to the membership drop it has always been', async () => {
    // E12-04's gesture is untouched: a row from g2 released over a row in g1
    // bubbles to the group card, which moves the session in. A reorder is
    // within one group, full stop — the two gestures never arbitrate.
    const m = await mount({
      sessions: [session('a', 'g1'), session('b', 'g1'), session('x', 'g2')],
      groups: [backend, infra],
    });
    await drag('x', 'a', 'top');
    expect(m.reorder).not.toHaveBeenCalled();
    expect(m.move).toHaveBeenCalledWith('x', 'g1');
  });

  it('reorders the UNGROUPED list too — on a workspace with no groups it IS the rail', async () => {
    const m = await mount({ sessions: [session('a'), session('b'), session('c')] });
    await drag('c', 'a', 'top');
    expect(m.reorder).toHaveBeenCalledWith('ungrouped', ['c', 'a', 'b']);
  });

  describe('and §5.8\u2019s pin, which wins', () => {
    it('will not let a drag displace a pinned session from the top', async () => {
      const m = await mount({
        sessions: [session('a', 'g1'), session('b', 'g1'), session('c', 'g1')],
        groups: [backend],
        pinned: ['a'],
      });
      expect(painted()).toEqual(['a', 'b', 'c']);
      // dropped above the pinned row, `c` gets as far as the pin allows
      await drag('c', 'a', 'top');
      expect(m.reorder).toHaveBeenCalledWith('g1', ['a', 'c', 'b']);
    });

    it('offers nothing at all when the pin leaves the row where it already is', async () => {
      const m = await mount({
        sessions: [session('a', 'g1'), session('b', 'g1')],
        groups: [backend],
        pinned: ['a'],
      });
      await drag('b', 'a', 'top');
      expect(m.reorder).not.toHaveBeenCalled();
    });
  });
});

// REORDERING FROM THE KEYBOARD IS NOT ON THIS MENU ANY MORE (#1168).
//
// "Move up" and "Move down" were two items on the session's right-click menu
// here, and six tests of them stood in this place. The owner chose one short
// session menu for both placements, and the pair went. The keyboard still has
// its way: `Ctrl+Alt+Up` / `Ctrl+Alt+Down` and the two "Move session" commands
// in the command list, which go through the store's `reorderSession` — whose
// own tests (store/session-store.test.ts, lib/session-voice.test.ts and
// lib/command-set.test.ts) hold every claim the six made: the order written,
// the ends of a group, the pin, the Ungrouped list, and the sentence spoken.
describe('the session menu and order (issue 1168)', () => {
  it('offers no Move up or Move down: order is by dragging, or by the chord', async () => {
    await mount({ sessions: [session('a', 'g1'), session('b', 'g1'), session('c', 'g1')], groups: [backend] });
    await act(async () => {
      rowOf('b').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(menu.querySelector('[data-order-item]')).toBeNull();
    expect(menu.textContent).not.toContain('Move up');
    expect(menu.textContent).not.toContain('Move down');
  });
});
