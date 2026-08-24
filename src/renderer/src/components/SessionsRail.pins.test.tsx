// @vitest-environment jsdom
// #295 — §5.8's pinning contract, the OVERFLOW clause: "a pinned session …
// never scrolls out of view under overflow".
//
// #78/#287 shipped the sort and the bulk-op exemptions and wrote down, in
// `lib/pinning.ts`, that this clause was the one it had NOT delivered. What
// makes it true is geometry — a `position: sticky` block — and geometry is the
// one thing jsdom cannot check: it has no layout engine, so nothing here can
// prove a row stayed on screen. The e2e case in `pinning.spec.ts` owns that.
//
// What THIS file owns is the structure the geometry needs, which is where a
// regression would actually come from:
//
//   • the pinned rows of a bucket are lifted into ONE sticky block (decision 2:
//     stacking is "one block per bucket", so two pins can never overlap);
//   • the block really carries `position: sticky` and an OPAQUE surface — a
//     transparent one would let the rows scroll visibly through it;
//   • the group card does NOT clip, because a clipping ancestor is a scroll
//     container and would measure the sticky box against a box that never
//     scrolls (i.e. would silently switch the feature off);
//   • no pins means no block at all — an empty wrapper would change the row
//     spacing of every unpinned workspace;
//   • the rail's ORDER is untouched (decision 1: sticky moves no session).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { SessionsRail } from './SessionsRail';
import { RailGroup, RailSession } from '../model/types';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { DEFAULT_FOCUS_BOOK } from '../lib/focus-policy';
import { NO_ORDER } from '../lib/rail-order';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { uiDelete } from '../lib/ui-state';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};

let host: HTMLDivElement;
let root: Root;

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

async function mount(opts: {
  sessions: RailSession[];
  groups?: RailGroup[];
  pinned?: string[];
  onTogglePin?: (cardId: string) => void;
}): Promise<void> {
  await act(async () => {
    root.render(
      <SessionsRail
        sessions={opts.sessions}
        groups={opts.groups ?? []}
        needing={new Set<string>()}
        palette={['var(--status-working)']}
        selectedId={null}
        policies={DEFAULT_BOOK}
        focusPolicies={DEFAULT_FOCUS_BOOK}
        pinned={new Set(opts.pinned ?? [])}
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
        onOpenInGroup={noop}
        onMoveToGroup={noop}
        onTogglePin={opts.onTogglePin ?? noop}
        onSetSessionPolicy={noop}
        onSetSessionFocusPolicy={noop}
        onCycleGroupPolicy={noop}
      />
    );
  });
}

/** the rail's order, top to bottom — the list Ctrl+1..9 counts against */
const painted = (): string[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-rail-open]')).map(
    (el) => el.getAttribute('data-rail-open') ?? ''
  );

const blocks = (): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-pinned-block]'));

/** the ids sitting inside the sticky block of one bucket */
const stuck = (bucket: string): string[] =>
  Array.from(
    host.querySelectorAll<HTMLElement>(`[data-pinned-block="${bucket}"] [data-rail-open]`)
  ).map((el) => el.getAttribute('data-rail-open') ?? '');

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  // the rail persists collapse state and width; a leftover would decide which
  // rows are in the DOM at all
  uiDelete(['railCollapsed', 'railWidth']);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the pinned rows of a bucket become one sticky block (#295)', () => {
  it('lifts a pin out of the flow and leaves the unpinned rows in it', async () => {
    await mount({ sessions: [session('a'), session('b'), session('c')], pinned: ['b'] });
    expect(blocks()).toHaveLength(1);
    expect(stuck('ungrouped')).toEqual(['b']);
    // ...and the rows that are NOT pinned are still ordinary children
    expect(painted()).toEqual(['b', 'a', 'c']);
  });

  it('sticks it to the top of the scroll region, painting its own card surface', async () => {
    await mount({ sessions: [session('a'), session('b')], pinned: ['a'] });
    const block = blocks()[0];
    expect(block.style.position).toBe('sticky');
    expect(block.style.insetBlockStart).toBe('0px');
    // The rows have to slide UNDER it, so it needs a background - and the one
    // it needs is the surface it is sitting on, or a stuck block reads as a
    // different kind of thing from the card it came out of. Asserted as "the
    // same value the card paints" rather than as a token name, so the pair
    // cannot drift and the test is not a copy of the line it is checking.
    // (Whether that surface is OPAQUE is a token fact, not a component one -
    // `--rail-card` and `--auto-surface` are, in every shipped theme.)
    let card = block.parentElement;
    while (card && !card.style.background) card = card.parentElement;
    expect(card).not.toBeNull();
    expect(block.style.background).toBe(card!.style.background);
    expect(block.style.background).not.toBe('');
    expect(block.style.background).not.toBe('transparent');
  });

  it('stacks two pins as ONE block, in rail order (decision 2)', async () => {
    await mount({ sessions: [session('a'), session('b'), session('c')], pinned: ['b', 'c'] });
    // one block, not two competing for the same top edge
    expect(blocks()).toHaveLength(1);
    expect(stuck('ungrouped')).toEqual(['b', 'c']);
  });

  it('renders no block at all when nothing is pinned', async () => {
    await mount({ sessions: [session('a'), session('b')] });
    expect(blocks()).toHaveLength(0);
  });

  it('gives every bucket that has a pin its own block', async () => {
    await mount({
      sessions: [session('a', 'g1'), session('b', 'g1'), session('c', 'g2'), session('d')],
      groups: [backend, infra],
      pinned: ['b', 'c'],
    });
    expect(blocks()).toHaveLength(2);
    expect(stuck('g1')).toEqual(['b']);
    expect(stuck('g2')).toEqual(['c']);
    // the ungrouped bucket has no pin, so it has no block
    expect(painted()).toEqual(['b', 'a', 'c', 'd']);
  });

  it('paints an auto-group block on the auto surface, not the card one', async () => {
    // two sessions in ONE folder is what makes an emergent group (E12-05)
    const shared = { ...session('a'), folder: 'C:\\p\\shared' };
    const other = { ...session('b'), folder: 'C:\\p\\shared' };
    await mount({ sessions: [shared, other], pinned: ['b'] });
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0].style.background).toBe('var(--auto-surface)');
  });
});

describe('the card must not clip, or the sticky block is measured against nothing', () => {
  it('leaves the group card unclipped and rounds the header instead', async () => {
    await mount({
      sessions: [session('a', 'g1')],
      groups: [backend],
      pinned: ['a'],
    });
    const head = host.querySelector<HTMLElement>('.rail-head')!;
    const card = head.parentElement!;
    // `overflow: hidden` here would make the CARD the nearest scroll container,
    // and a sticky box measured against a box that never scrolls never sticks.
    expect(card.style.overflow).toBe('');
    // the corners the clip used to round, rounded by the header itself
    expect(head.style.borderStartStartRadius).toBe('7px');
    expect(head.style.borderStartEndRadius).toBe('7px');
  });
});

describe('sticky moves no session (decision 1)', () => {
  it('keeps rail order identical to the unpinned-render order', async () => {
    // the same four sessions, rendered with and without the lift: the ORDER is
    // `railOrder`'s answer either way, because `bucketRows` only re-parents a
    // prefix it was already handed in that order
    await mount({
      sessions: [session('a', 'g1'), session('b', 'g1'), session('c')],
      groups: [backend],
      pinned: ['b'],
    });
    expect(painted()).toEqual(['b', 'a', 'c']);
    // and the pinned row is still a real, draggable, openable row — not a
    // decoration in a shelf
    const row = host.querySelector<HTMLElement>('[data-pinned-block] .rail-row')!;
    expect(row.getAttribute('draggable')).toBe('true');
    expect(row.getAttribute('data-pinned')).toBe('true');
  });
});

// The focus half of the same change, and the one a screenshot cannot show.
//
// Pinning from the row's context menu used to be safe to restore focus from
// synchronously: the sort only reordered SIBLINGS, so the button the menu was
// opened from survived it. Lifting the pins into their own block makes the row
// change PARENT ELEMENT, which React cannot do without unmounting and
// remounting it - so the node the menu was holding is detached by the time the
// store answers, and focusing it drops the keyboard on <body>. The menu item's
// own comment promises the opposite ("the row is still there afterwards"), so
// this is that promise being kept rather than a new one.
describe('pinning from the keyboard keeps the keyboard (#295 / #197)', () => {
  /** open the row menu the way Shift+F10 does - no pointer, so (0, 0) */
  async function openMenu(id: string): Promise<void> {
    const open = host.querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!;
    open.focus();
    await act(async () => {
      open.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0 })
      );
    });
  }

  const menuItem = (label: string): HTMLElement =>
    Array.from(host.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (el) => el.textContent === label
    )!;

  it('lands focus back on the row it just pinned, after the store agrees', async () => {
    let asked: string | null = null;
    const sessions = [session('a'), session('b'), session('c')];
    await mount({ sessions, onTogglePin: (id) => (asked = id) });
    await openMenu('c');

    await act(async () => {
      menuItem(en.rail.menuPin).click();
    });
    expect(asked).toBe('c');
    // ...and NOT yet: the row is still where it was, and the store has not
    // answered. Restoring here is what put focus on a doomed node.
    expect(host.querySelector('[data-pinned-block]')).toBeNull();

    // the store answers — this is the re-render the effect is waiting for
    await mount({ sessions, pinned: ['c'], onTogglePin: noop });
    const row = host.querySelector<HTMLElement>('[data-rail-open="c"]')!;
    expect(row.closest('[data-pinned-block]')).not.toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('does the same on the way back out, when the block disappears', async () => {
    const sessions = [session('a'), session('b')];
    await mount({ sessions, pinned: ['b'] });
    await openMenu('b');
    await act(async () => {
      menuItem(en.rail.menuUnpin).click();
    });
    await mount({ sessions });
    expect(host.querySelector('[data-pinned-block]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-rail-open="b"]'));
  });

  it('does not yank focus back from wherever the user has since gone', async () => {
    const sessions = [session('a'), session('b')];
    await mount({ sessions });
    await openMenu('b');
    await act(async () => {
      menuItem(en.rail.menuPin).click();
    });
    // somewhere else entirely, outside the rail, before the store answers
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await mount({ sessions, pinned: ['b'] });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
