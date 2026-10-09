// @vitest-environment jsdom
// #951 — §5.15's "↳ Review of X": what the rail DRAWS for a dispatched session.
//
// The nesting ORDER is proved on `railOrder` itself (`lib/groups.test.ts`), which
// is what the done-when asks for and which is where a regression in the rule would
// come from. This file owns the two things only the component can be asked:
//
//   • the connector and the indent come from the ORDER's `depthOf`, so a row the
//     nesting could not place — an author closed, an author in another bucket, an
//     author on the other side of a pin — gets no arrow pointing at nothing;
//   • the connector is decoration. The relationship is already in the card's own
//     title ("Code Reviewer of Alpha"), which the row label reads out, so a second
//     spoken "nested under" would say the same thing twice to the one user who
//     cannot see the indent doing the work.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { SessionsRail } from './SessionsRail';
import { RailGroup, RailSession } from '../model/types';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { NO_ORDER } from '../lib/rail-order';
import { LineageMap } from '../lib/dispatch-lineage';
import { initI18nForTests } from '../i18n/test-i18n';
import { uiDelete } from '../lib/ui-state';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};

let host: HTMLDivElement;
let root: Root;

const session = (id: string, over: Partial<RailSession> = {}): RailSession => ({
  id,
  title: id,
  status: 'idle',
  // a folder each, so nothing emergently auto-groups underneath the test unless
  // the test asks for it
  folder: `C:\\p\\${id}`,
  ...over,
});

let reorders: Array<{ bucket: string; ids: string[] }>;

async function mount(opts: {
  sessions: RailSession[];
  groups?: RailGroup[];
  pinned?: string[];
  lineage?: LineageMap;
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
        pinned={new Set(opts.pinned ?? [])}
        manualOrder={NO_ORDER}
        {...(opts.lineage ? { lineage: opts.lineage } : {})}
        onReorder={(bucket, ids) => reorders.push({ bucket, ids })}
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

/** the row element for a card, whatever it is nested inside */
const row = (id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!.closest<HTMLElement>('.rail-row')!;

const connectors = (): string[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-rail-lineage]')).map(
    (el) => el.getAttribute('data-rail-lineage') ?? ''
  );

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  reorders = [];
  uiDelete(['railCollapsed', 'railWidth']);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a dispatched session nests under the session that sent it', () => {
  it('⭐ DRAWS THE CONNECTOR AND INDENTS, directly under its author', async () => {
    await mount({
      sessions: [session('author'), session('other'), session('reviewer')],
      lineage: new Map([['reviewer', 'author']]),
    });
    expect(painted()).toEqual(['author', 'reviewer', 'other']);
    expect(connectors()).toEqual(['reviewer']);
    expect(row('reviewer').getAttribute('data-rail-depth')).toBe('1');
    expect(row('author').hasAttribute('data-rail-depth')).toBe(false);
    // the indent is the only visible difference between a nested row and a
    // top-level one, and jsdom can at least be asked whether it was applied
    const nested = Number.parseFloat(row('reviewer').style.paddingInlineStart);
    const top = Number.parseFloat(row('author').style.paddingInlineStart);
    expect(nested).toBeGreaterThan(top);
  });

  it('indents a chain further — a reviewer that dispatched its own reviewer', async () => {
    await mount({
      sessions: [session('a'), session('b'), session('c')],
      lineage: new Map([
        ['b', 'a'],
        ['c', 'b'],
      ]),
    });
    expect(painted()).toEqual(['a', 'b', 'c']);
    expect([row('b'), row('c')].map((el) => el.getAttribute('data-rail-depth'))).toEqual(['1', '2']);
  });

  it('⚠️ DRAWS NOTHING FOR A CHILD WHOSE AUTHOR IS GONE — no arrow pointing at nothing', async () => {
    await mount({
      sessions: [session('reviewer'), session('other')],
      lineage: new Map([['reviewer', 'author-that-was-closed']]),
    });
    expect(painted()).toEqual(['reviewer', 'other']);
    expect(connectors()).toEqual([]);
    expect(row('reviewer').hasAttribute('data-rail-depth')).toBe(false);
  });

  it('⚠️ AND NOTHING WHEN THE PIN KEPT THEM APART (§5.8 wins)', async () => {
    // A pinned reviewer sorts into the sticky block above its unpinned author, so
    // an indent there would be an arrow pointing DOWN the list. The order's own
    // answer is "not nested", and the row follows it.
    await mount({
      sessions: [session('author'), session('reviewer')],
      pinned: ['reviewer'],
      lineage: new Map([['reviewer', 'author']]),
    });
    expect(painted()).toEqual(['reviewer', 'author']);
    expect(connectors()).toEqual([]);
  });

  it('nests inside an auto-group, which is where a same-folder dispatch lands', async () => {
    // §5.15 v1 is `same-folder` (#949): the reviewer runs in the author's folder,
    // so the two emerge as one auto-group. This is the real shape, not a contrived
    // one, and the nesting has to survive it.
    await mount({
      sessions: [
        session('author', { folder: 'C:\\p\\app' }),
        session('reviewer', { folder: 'C:\\p\\app' }),
      ],
      lineage: new Map([['reviewer', 'author']]),
    });
    expect(painted()).toEqual(['author', 'reviewer']);
    expect(connectors()).toEqual(['reviewer']);
  });

  it('the connector is aria-hidden — the relationship is in the title, spoken once', async () => {
    await mount({
      sessions: [session('author'), session('reviewer', { title: 'Code Reviewer of author' })],
      lineage: new Map([['reviewer', 'author']]),
    });
    const glyph = host.querySelector<HTMLElement>('[data-rail-lineage]')!;
    expect(glyph.getAttribute('aria-hidden')).not.toBeNull();
    expect(
      host.querySelector<HTMLElement>('[data-rail-open="reviewer"]')!.getAttribute('aria-label')
    ).toContain('Code Reviewer of author');
  });

  it('a workspace that has never dispatched draws no connectors at all', async () => {
    await mount({ sessions: [session('a'), session('b')] });
    expect(connectors()).toEqual([]);
    expect(painted()).toEqual(['a', 'b']);
  });
});

// The row menu's Move up / Move down, with a lineage, were tested here: three
// cases for a defect where the item was drawn enabled on an author and then
// did nothing. The items left the menu in #1168. The rule they shared with the
// chord is the store's, and `reorderSession respects the nesting` in
// store/session-store.test.ts holds it.
