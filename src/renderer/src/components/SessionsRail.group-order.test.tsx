// @vitest-environment jsdom
// #1144 — groups in the Sessions list can be put in a different order.
//
// The arithmetic ("one above", "just below that one") is `lib/group-order`'s and
// is tested there, and what main does with the answer is `store.test.ts`'s.
// This file owns what only a mounted rail can answer: that the menu and the
// drag both reach `onMoveGroup` with that arithmetic's answer, that neither is
// offered where it would do nothing, and — the part #582 worried about — that
// a GROUP in flight is never mistaken for a SESSION being dropped into the
// group next door.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { act } from 'react';
import { SessionsRail } from './SessionsRail';
import { RailGroup, RailSession } from '../model/types';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { NO_ORDER } from '../lib/rail-order';
import { initI18nForTests } from '../i18n/test-i18n';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};
const GROUP_TYPE = 'application/x-switchboard-group';
const CARD_TYPE = 'application/x-switchboard-card';

let host: HTMLDivElement;
let root: Root;
let moveGroup: ReturnType<typeof vi.fn>;
let moveToGroup: ReturnType<typeof vi.fn>;

const group = (id: string): RailGroup => ({
  id,
  name: id.toUpperCase(),
  color: 'var(--status-working)',
});
const A = group('a');
const B = group('b');
const C = group('c');

const session = (id: string, groupId?: string): RailSession => ({
  id,
  title: id,
  status: 'idle',
  folder: `C:\\p\\${id}`,
  ...(groupId ? { groupId } : {}),
});

async function mount(groups: RailGroup[], sessions: RailSession[] = [], canMove = true): Promise<void> {
  await act(async () => {
    root.render(
      <SessionsRail
        sessions={sessions}
        groups={groups}
        needing={new Set<string>()}
        palette={['var(--status-working)']}
        selectedId={null}
        policies={DEFAULT_BOOK}
        pinned={new Set<string>()}
        manualOrder={NO_ORDER}
        onReorder={noop}
        onRename={noop}
        onFocus={noop}
        onDiff={noop}
        onClose={noop}
        onCreateGroup={noop}
        onRenameGroup={noop}
        onRecolorGroup={noop}
        onDeleteGroup={noop}
        onMoveGroup={canMove ? moveGroup : undefined}
        onOpenInGroup={noop}
        onMoveToGroup={moveToGroup}
        onTogglePin={noop}
        onCycleGroupPolicy={noop}
      />
    );
  });
}

const head = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-group-head="${id}"]`)!;
const card = (key: string): HTMLElement => host.querySelector<HTMLElement>(`[data-group-card="${key}"]`)!;
const toggle = (id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-rail-group-toggle="${id}"]`)!;
const menu = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="rail-group-menu"]');
const item = (id: 'up' | 'down'): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-group-menu-item="${id}"]`)!;
const line = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-group-drop-line]');

async function rightClick(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  });
}

/** a drag event jsdom can dispatch: it has no DragEvent with a dataTransfer */
function dragEvent(type: string, types: string[], data: Record<string, string>, clientY = 1): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types,
      setData: (k: string, v: string) => {
        data[k] = v;
        if (!types.includes(k)) types.push(k);
      },
      getData: (k: string) => data[k] ?? '',
      effectAllowed: '',
      dropEffect: '',
    },
  });
  return e;
}

/** pick a group up by its header; returns what its dataTransfer now carries */
async function pickUp(id: string): Promise<{ types: string[]; data: Record<string, string> }> {
  const types: string[] = [];
  const data: Record<string, string> = {};
  await act(async () => {
    head(id).dispatchEvent(dragEvent('dragstart', types, data));
  });
  return { types, data };
}

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  moveGroup = vi.fn();
  moveToGroup = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Move up / Move down on a group’s menu (#1144)', () => {
  it('right-click on a group’s header opens its menu, named for the group', async () => {
    await mount([A, B, C]);
    expect(menu()).toBeNull();
    await rightClick(head('b'));
    expect(menu()).not.toBeNull();
    expect(menu()!.getAttribute('aria-label')).toBe(i18next.t('rail.groupMenuLabel', { name: 'B' }));
    expect(item('up').textContent).toBe(i18next.t('rail.groupMoveUp'));
    expect(item('down').textContent).toBe(i18next.t('rail.groupMoveDown'));
  });

  it('Move up asks for the group to go before the one above it', async () => {
    await mount([A, B, C]);
    await rightClick(head('c'));
    await act(async () => item('up').click());
    expect(moveGroup).toHaveBeenCalledWith('c', 'b');
    expect(menu()).toBeNull();
  });

  it('Move down asks for the place after the next one — last, at the end', async () => {
    await mount([A, B, C]);
    await rightClick(head('a'));
    await act(async () => item('down').click());
    expect(moveGroup).toHaveBeenCalledWith('a', 'c');
    await rightClick(head('b'));
    await act(async () => item('down').click());
    expect(moveGroup).toHaveBeenLastCalledWith('b', null);
  });

  // an offer that would do nothing is dimmed, stays focusable, and does nothing
  it('dims the item that has nowhere to go, and it does nothing', async () => {
    await mount([A, B, C]);
    await rightClick(head('a'));
    expect(item('up').getAttribute('aria-disabled')).toBe('true');
    expect(item('down').getAttribute('aria-disabled')).toBe('false');
    await act(async () => item('up').click());
    expect(moveGroup).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull(); // still open: nothing happened

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(menu()).toBeNull();
    await rightClick(head('c'));
    expect(item('down').getAttribute('aria-disabled')).toBe('true');
  });

  it('opens from the keyboard too: the Menu key and Shift+F10 on the group’s name', async () => {
    await mount([A, B]);
    await act(async () => {
      toggle('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(menu()).toBeNull();
    // Escape hands the keyboard back to the group it was opened on
    expect(document.activeElement).toBe(toggle('b'));
    await act(async () => {
      toggle('b').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })
      );
    });
    expect(menu()).not.toBeNull();
  });

  // a keyboard move is otherwise a fact carried entirely by the screen
  it('after a move lands, focus is on the group that moved and the move is said aloud', async () => {
    await mount([A, B, C]);
    await rightClick(head('c'));
    await act(async () => item('up').click());
    // main answers with the new order and the rail is redrawn from it
    await mount([A, C, B]);
    expect(document.activeElement).toBe(toggle('c'));
    expect(host.querySelector('[role="status"]')!.textContent).toBe(
      i18next.t('rail.groupReordered', { name: 'C', position: 2, count: 3 })
    );
  });

  it('offers no menu on the Ungrouped card, or with nowhere to save an order', async () => {
    await mount([A, B], [session('s1')]);
    await rightClick(card('ungrouped').querySelector<HTMLElement>('.rail-head')!);
    expect(menu()).toBeNull();
    await mount([A, B], [], false);
    await rightClick(head('a'));
    expect(menu()).toBeNull();
    expect(head('a').draggable).toBe(false);
  });
});

describe('dragging a group by its header (#1144)', () => {
  it('a group’s header is draggable; Ungrouped’s and a lone group’s are not', async () => {
    await mount([A, B], [session('s1')]);
    expect(head('a').draggable).toBe(true);
    expect(card('ungrouped').querySelector<HTMLElement>('.rail-head')!.draggable).toBe(false);
    await mount([A]);
    expect(head('a').draggable).toBe(false);
  });

  // the owner's example: the bottom group, dropped on the top half of the second
  it('dropping the bottom group above the second makes it second', async () => {
    await mount([A, B, C]);
    const { types, data } = await pickUp('c');
    expect(types).toEqual([GROUP_TYPE]);

    const over = dragEvent('dragover', types, data, -1); // top half
    await act(async () => {
      card('b').dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true); // a real drop target
    expect(line()!.dataset.groupDropLine).toBe('before');
    expect(card('b').contains(line())).toBe(true);

    await act(async () => {
      card('b').dispatchEvent(dragEvent('drop', types, data, -1));
    });
    expect(moveGroup).toHaveBeenCalledWith('c', 'b');
    expect(line()).toBeNull();
  });

  it('the bottom half lands it below, and below the last group is "last"', async () => {
    await mount([A, B, C]);
    const { types, data } = await pickUp('a');
    await act(async () => {
      card('c').dispatchEvent(dragEvent('dragover', types, data, 1));
    });
    expect(line()!.dataset.groupDropLine).toBe('after');
    await act(async () => {
      card('c').dispatchEvent(dragEvent('drop', types, data, 1));
    });
    expect(moveGroup).toHaveBeenCalledWith('a', null);
  });

  // no line, and not a drop target, where nothing would move
  it('draws no line where the group already sits', async () => {
    await mount([A, B, C]);
    const { types, data } = await pickUp('b');
    for (const [target, y] of [['b', -1], ['b', 1], ['a', 1], ['c', -1]] as const) {
      const over = dragEvent('dragover', types, data, y);
      await act(async () => {
        card(target).dispatchEvent(over);
      });
      expect(over.defaultPrevented, `${target} ${y}`).toBe(false);
      expect(line()).toBeNull();
    }
  });

  // ⚠️ #582: a group passing over another group must NEVER read as a session
  // being dropped into it.
  it('⚠️ a group drag is never taken for a session drop', async () => {
    await mount([A, B, C], [session('s1', 'a')]);
    const { types, data } = await pickUp('c');
    await act(async () => {
      card('a').dispatchEvent(dragEvent('dragover', types, data, -1));
      card('a').dispatchEvent(dragEvent('drop', types, data, -1));
    });
    expect(moveGroup).toHaveBeenCalledWith('c', 'a');
    expect(moveToGroup).not.toHaveBeenCalled();

    // …nor over the Ungrouped card, which is the "ungroup this session" target
    const again = await pickUp('c');
    const over = dragEvent('dragover', again.types, again.data, -1);
    await act(async () => {
      card('ungrouped')?.dispatchEvent(over);
      host.querySelector('nav')!.dispatchEvent(dragEvent('drop', again.types, again.data, -1));
    });
    expect(over.defaultPrevented).toBe(false);
    expect(moveToGroup).not.toHaveBeenCalled();
  });

  // …and the other way round: a session dragged between groups still does
  // exactly what it did, and moves no group.
  it('⚠️ a session dropped on a group still joins it, and moves no group', async () => {
    await mount([A, B], [session('s1', 'a')]);
    const types = [CARD_TYPE];
    const data = { [CARD_TYPE]: 's1' };
    const over = dragEvent('dragover', types, data, -1);
    await act(async () => {
      card('b').dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(line()).toBeNull();
    await act(async () => {
      card('b').dispatchEvent(dragEvent('drop', types, data, -1));
    });
    expect(moveToGroup).toHaveBeenCalledWith('s1', 'b');
    expect(moveGroup).not.toHaveBeenCalled();
  });

  // a row starts its OWN drag from inside the card; it must not leave as a group
  it('dragging a session row out of a group does not pick the group up', async () => {
    await mount([A, B], [session('s1', 'a')]);
    const types: string[] = [];
    const data: Record<string, string> = {};
    await act(async () => {
      host.querySelector<HTMLElement>('.rail-row')!.dispatchEvent(dragEvent('dragstart', types, data));
    });
    expect(types).toEqual([CARD_TYPE]);
  });
});
