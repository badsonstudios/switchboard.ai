// @vitest-environment jsdom
// #687 — the row for a card main has never heard of.
//
// The STORE half (how such a row gets into `props.sessions` at all, and the
// dedupe that stops a card main DOES know about getting a second one) is tested
// in `store/session-store.test.ts`; the PAINT half (the idle ramp, the label) is
// `lib/rail-view.test.ts`. This file owns the third thing, which only a mounted
// rail can answer: which of the row's own actions are still offered.
//
// The rule under test is not "not-started rows are read-only". It is narrower
// and it is the honest one: an action is withdrawn exactly when its main-side
// handler would silently do nothing.
//
//   * `sessions:renameCard`      -> `if (prior) upsert(...)`     nothing
//   * `groups:setSessionGroup`   -> `if (!s) return`             nothing
//   * pin, close, reorder, both policy sets -> renderer state    everything
//
// A card that DOES have a record and is merely suspended keeps all of it, and
// the last test here is that control: without it this file would pass just as
// well against a rail that greyed out Rename for everybody.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { act } from 'react';
import { SessionsRail } from './SessionsRail';
import { RailGroup, RailSession } from '../model/types';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DEFAULT_FOCUS_BOOK } from '../lib/focus-policy';
import { NO_ORDER } from '../lib/rail-order';
import { initI18nForTests } from '../i18n/test-i18n';
import { uiDelete } from '../lib/ui-state';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};

let host: HTMLDivElement;
let root: Root;

/** see the reorder file: a token rather than `#rrggbb`, for the lint rule */
const backend: RailGroup = { id: 'g1', name: 'Backend', color: 'var(--status-working)' };

/** a card main knows about, sitting idle — the control */
const known = (id: string, over: Partial<RailSession> = {}): RailSession => ({
  id,
  title: id,
  status: 'suspended',
  folder: `C:\\p\\${id}`,
  ...over,
});

/** a card whose `sessions:create` was refused, exactly as the store mints it */
const notStarted = (id: string, over: Partial<RailSession> = {}): RailSession => ({
  id,
  title: id,
  status: 'not-started',
  folder: `C:\\p\\${id}`,
  ...over,
});

interface Mounted {
  rename: ReturnType<typeof vi.fn>;
  move: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  pin: ReturnType<typeof vi.fn>;
}

async function mount(sessions: RailSession[], groups: RailGroup[] = []): Promise<Mounted> {
  const rename = vi.fn();
  const move = vi.fn();
  const close = vi.fn();
  const pin = vi.fn();
  await act(async () => {
    root.render(
      <SessionsRail
        sessions={sessions}
        groups={groups}
        needing={new Set<string>()}
        palette={['var(--status-working)']}
        selectedId={null}
        policies={DEFAULT_BOOK}
        focusPolicies={DEFAULT_FOCUS_BOOK}
        pinned={new Set<string>()}
        manualOrder={NO_ORDER}
        onReorder={noop}
        onRename={rename}
        onFocus={noop}
        onDiff={noop}
        onClose={close}
        onCreateGroup={noop}
        onRenameGroup={noop}
        onRecolorGroup={noop}
        onDeleteGroup={noop}
        onOpenInGroup={noop}
        onMoveToGroup={move}
        onTogglePin={pin}
        onSetSessionPolicy={noop}
        onSetSessionFocusPolicy={noop}
        onCycleGroupPolicy={noop}
      />
    );
  });
  return { rename, move, close, pin };
}

const rowOf = (id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!.closest<HTMLElement>('.rail-row')!;

/**
 * A group's card, reached through its header.
 *
 * The card itself carries no id attribute — the header does, and the card's
 * own comment says a drop on the header "bubbles to here", so dispatching at
 * the header exercises the real path rather than a shortcut to the handler.
 */
const groupCard = (key: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-rail-group-toggle="${key}"]`)!;

/** the dataTransfer a rail-row drag carries; jsdom supplies none */
const transfer = (): unknown => ({
  setData: noop,
  getData: () => '',
  types: ['application/x-switchboard-card'],
  effectAllowed: '',
});

/** open a row's context menu */
async function openMenu(id: string): Promise<void> {
  await act(async () => {
    rowOf(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
}

/**
 * A menu item by its i18n KEY.
 *
 * Found by its visible label rather than a test id — the four top items are
 * rendered from one array, and a hook added only for the test is a hook that
 * can drift from what the user sees. The label is resolved through the same
 * i18next singleton the component reads, so the lookup cannot go stale when the
 * wording changes (and does not have to spell an ellipsis into the source).
 */
function item(key: string): HTMLElement | undefined {
  const label = i18next.t(key);
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')).find(
    (el) => el.textContent?.trim() === label
  );
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

describe('a not-started row is in the rail at all (#687)', () => {
  it('paints a row for a card main has never heard of', async () => {
    await mount([known('a'), notStarted('ghost')]);
    // the assertion the whole issue is about: the Sessions list is the complete
    // inventory, which it was not while this card had no row
    expect(host.querySelector('[data-rail-open="ghost"]')).not.toBeNull();
  });
});

describe('the actions a not-started row keeps (#687)', () => {
  it('offers Close, and calls it', async () => {
    const m = await mount([notStarted('ghost')]);
    await openMenu('ghost');
    const close = item('rail.menuClose')!;
    expect(close.getAttribute('aria-disabled')).toBe('false');
    await act(async () => close.click());
    expect(m.close).toHaveBeenCalledWith('ghost');
  });

  it('offers Pin, and calls it — the pin set is renderer state', async () => {
    const m = await mount([notStarted('ghost')]);
    await openMenu('ghost');
    const pin = item('rail.menuPin')!;
    expect(pin.getAttribute('aria-disabled')).toBe('false');
    await act(async () => pin.click());
    expect(m.pin).toHaveBeenCalledWith('ghost');
  });
});

describe('the actions a not-started row withdraws (#687)', () => {
  it('dims Rename, and a click on it does nothing', async () => {
    const m = await mount([notStarted('ghost')]);
    await openMenu('ghost');
    const rename = item('rail.menuRename')!;
    expect(rename.getAttribute('aria-disabled')).toBe('true');

    // ARIA-DISABLED IS A CLAIM; this is the fact. A button that announces
    // itself unavailable and still runs is the worse of the two bugs, because
    // nothing on screen would show that the rename was dropped.
    await act(async () => rename.click());
    expect(m.rename).not.toHaveBeenCalled();
    // ...and the menu is still up: the click was declined, not handled
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // no inline edit field was armed either
    expect(host.querySelector('input')).toBeNull();
  });

  it('keeps Rename focusable — the arrow walk must not stop dead on it', async () => {
    // `aria-disabled` and not `disabled`, the same rule the reorder items
    // follow: the menu's arrow walk collects `[role^="menuitem"]` and focuses
    // them, and `focus()` on a disabled button does nothing at all.
    await mount([notStarted('ghost')]);
    await openMenu('ghost');
    const rename = item('rail.menuRename')!;
    expect(rename.hasAttribute('disabled')).toBe(false);
    rename.focus();
    expect(document.activeElement).toBe(rename);
  });

  it('does not arm the rename field on DOUBLE-CLICK either', async () => {
    // The second door to the same edit box. Review caught that gating only the
    // menu item would move the silent no-op behind a gesture with no label on
    // it — the field would open, take the typing, and the next refresh would
    // paint the old name back.
    await mount([notStarted('ghost')]);
    await act(async () => {
      rowOf('ghost').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(host.querySelector('input')).toBeNull();
  });

  it('...but a card main knows about still renames on double-click', async () => {
    await mount([known('a')]);
    await act(async () => {
      rowOf('a').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(host.querySelector('input')).not.toBeNull();
  });

  it('refuses a DRAG into a group — no preventDefault, so the cursor says no', async () => {
    // The drag is Move-to-group with no label on it, so it is refused the way
    // an auto-group is: swallow the dragover WITHOUT preventing it, and the
    // browser then fires no `drop` at all.
    const m = await mount([notStarted('ghost'), known('a', { groupId: 'g1' })], [backend]);
    const card = groupCard('g1');

    await act(async () => {
      rowOf('ghost').dispatchEvent(
        Object.assign(new MouseEvent('dragstart', { bubbles: true }), { dataTransfer: transfer() })
      );
    });
    const over = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    await act(async () => {
      card.dispatchEvent(Object.assign(over, { dataTransfer: transfer() }));
    });

    // NOT prevented is the whole assertion: `drop` only fires where `dragover`
    // was prevented, so this is what makes the gesture impossible rather than
    // merely ineffective.
    expect(over.defaultPrevented).toBe(false);
    expect(m.move).not.toHaveBeenCalled();
  });

  it('...but a known card still drops into a group', async () => {
    // the control: without it this file would pass against a rail that had
    // simply stopped accepting drags
    await mount([known('a'), known('b', { groupId: 'g1' })], [backend]);
    const card = groupCard('g1');

    await act(async () => {
      rowOf('a').dispatchEvent(
        Object.assign(new MouseEvent('dragstart', { bubbles: true }), { dataTransfer: transfer() })
      );
    });
    const over = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    await act(async () => {
      card.dispatchEvent(Object.assign(over, { dataTransfer: transfer() }));
    });

    expect(over.defaultPrevented).toBe(true);
  });

  it('drops the Move-to-group set entirely', async () => {
    // A whole SET that can do nothing goes; a single item that is merely
    // unavailable stays and dims. Every entry here would reach
    // `store.setSessionGroup`, whose first line is `if (!s) return`.
    await mount([notStarted('ghost'), known('a', { groupId: 'g1' })], [backend]);
    await openMenu('ghost');
    expect(document.querySelector('[data-move-item="g1"]')).toBeNull();
    expect(document.querySelector('[data-move-item="ungrouped"]')).toBeNull();
  });
});

describe('the control: a card main DOES know about keeps everything', () => {
  it('a suspended row renames and moves', async () => {
    // Without this test the file would pass against a rail that had simply
    // greyed out Rename for every row.
    const m = await mount([known('a'), known('b', { groupId: 'g1' })], [backend]);
    await openMenu('a');

    const rename = item('rail.menuRename')!;
    expect(rename.getAttribute('aria-disabled')).toBe('false');
    expect(document.querySelector('[data-move-item="g1"]')).not.toBeNull();

    const move = document.querySelector<HTMLElement>('[data-move-item="g1"]')!;
    await act(async () => move.click());
    expect(m.move).toHaveBeenCalledWith('a', 'g1');
  });
});
