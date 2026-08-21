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
        onTogglePin={noop}
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

  it('sticks it to the top of the scroll region, on an opaque surface', async () => {
    await mount({ sessions: [session('a'), session('b')], pinned: ['a'] });
    const block = blocks()[0];
    expect(block.style.position).toBe('sticky');
    expect(block.style.insetBlockStart).toBe('0px');
    // the rows have to slide UNDER it. A transparent block is the bug that
    // looks like it works until something scrolls.
    expect(block.style.background).toBe('var(--rail-card)');
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
