// @vitest-environment jsdom
// ONE session menu, in both places (#1168).
//
// Right-clicking a session gave a long menu in the list on the left and a short
// one on the strip across the top. The owner picked the short one for both.
// This file mounts both lists over the same sessions and groups and holds them
// to the same answer, so the next item added to one has to be added to the
// other, or this goes red.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsRail } from './SessionsRail';
import { SessionsStrip } from './SessionsStrip';
import { uiDelete } from '../lib/ui-state';
import { NO_ORDER } from '../lib/rail-order';
import { railOrder } from '../lib/groups';
import { RailGroup, RailSession } from '../model/types';
import { IdentityTab, type CardParams } from './SessionGrid';
import { sessionStore } from '../store/session-store';
import { SessionMenuActionsContext } from '../lib/session-menu';
import type { IDockviewPanelProps } from 'dockview-react';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};
// a token, not a hex colour: the raw-colour lint cannot tell data from styling
const BACK: RailGroup = { id: 'g1', name: 'Backend', color: 'var(--status-working)' };
const DOCS: RailGroup = { id: 'g2', name: 'Docs', color: 'var(--status-working)' };
const SESSIONS: RailSession[] = [
  { id: 'api', title: 'api', status: 'idle', groupId: BACK.id },
  { id: 'web', title: 'web', status: 'idle', groupId: BACK.id },
  { id: 'scratch', title: 'scratch', status: 'idle' },
  { id: 'dud', title: 'dud', status: 'not-started' },
];

let roots: Root[] = [];
/** sessions with finished work nobody has looked at (#1219), for both mounts */
let finishedIds: string[] = [];

async function mountRail(groups: RailGroup[]): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <SessionsRail
        sessions={SESSIONS.map((s) => (groups.length ? s : { ...s, groupId: undefined }))}
        groups={groups}
        needing={new Set<string>()}
        finished={new Set<string>(finishedIds)}
        palette={['var(--status-working)']}
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
        pinned={new Set()}
        onTogglePin={noop}
        manualOrder={NO_ORDER}
        onReorder={noop}
      />
    );
  });
  return host;
}

async function mountStrip(groups: RailGroup[]): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const sessions = SESSIONS.map((s) => (groups.length ? s : { ...s, groupId: undefined }));
  const pinned = new Set<string>();
  await act(async () => {
    root.render(
      <SessionsStrip
        shown
        folded={new Set()}
        urgency={new Map()}
        groups={groups}
        order={railOrder(sessions, groups, pinned)}
        needing={new Set()}
        finished={new Set<string>(finishedIds)}
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
        onDeleteGroup={noop}
        onOpenAll={noop}
        onPlace={noop}
        onReorder={noop}
        onMoveGroup={noop}
      />
    );
  });
  return host;
}

interface Entry {
  label: string;
  checked: string | null;
  dimmed: boolean;
}

/** what the open menu offers, in order: the words, the tick, and whether dimmed */
function entries(): Entry[] {
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  return Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).map((el) => ({
    // the tick is decoration; `aria-checked` is the fact
    label: (el.textContent ?? '').replace('✓', '').trim(),
    checked: el.getAttribute('aria-checked'),
    dimmed: el.getAttribute('aria-disabled') === 'true',
  }));
}

async function rightClick(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    );
  });
}

async function closeMenu(): Promise<void> {
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) return;
  await act(async () => {
    (menu.querySelector<HTMLElement>('[role^="menuitem"]') ?? menu).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  });
}

/** the session's menu in the left list, then on the strip */
async function both(groups: RailGroup[], id: string): Promise<{ left: Entry[]; top: Entry[] }> {
  const rail = await mountRail(groups);
  await rightClick(
    rail.querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!.closest<HTMLElement>('.rail-row')!
  );
  const left = entries();
  await act(async () => roots.pop()!.unmount());
  rail.remove();
  document.body.innerHTML = '';

  const strip = await mountStrip(groups);
  // a session in a group is a row in the group's list on the strip; a loose one
  // is a pill. Both open the same menu.
  let target = strip.querySelector<HTMLElement>(`[data-strip-pill="${id}"]`);
  if (!target) {
    const open = strip.querySelector<HTMLElement>('[data-strip-group-open]')!;
    await act(async () => open.click());
    target = document.querySelector<HTMLElement>(`[data-rail-open="${id}"]`)!;
  }
  await rightClick(target);
  const top = entries();
  await closeMenu();
  return { left, top };
}

/**
 * The same session's menu on its TAB in the workspace (#1281). The tab reads
 * the session, the groups and the pins from the store, as it does in the app,
 * so they are published there first.
 */
async function tabMenu(groups: RailGroup[], id: string): Promise<Entry[]> {
  sessionStore.setSessions(SESSIONS.map((s) => (groups.length ? s : { ...s, groupId: undefined })));
  sessionStore.setGroups(groups);
  const finished = vi
    .spyOn(sessionStore, 'getFinishedCards')
    .mockReturnValue(new Set<string>(finishedIds));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const props = {
    api: {
      id: `session-${id}`,
      title: id,
      close: noop,
      group: { panels: [] },
      location: { type: 'grid' },
    },
    containerApi: {},
    params: { cardId: id, folder: `C:\\Projects\\${id}`, title: id },
  } as unknown as IDockviewPanelProps<CardParams>;
  await act(async () => {
    root.render(
      <SessionMenuActionsContext.Provider
        value={{ rename: noop, diff: noop, moveToGroup: noop, togglePin: noop }}
      >
        <IdentityTab {...props} />
      </SessionMenuActionsContext.Provider>
    );
  });
  await rightClick(host.querySelector<HTMLElement>('.identity-tab')!);
  const got = entries();
  await closeMenu();
  finished.mockRestore();
  return got;
}

/** the list's items, found in the tab's menu: same words, dimming and ticks */
function sharedWith(list: Entry[], tab: Entry[]): Entry[] {
  return list.map((l) => tab.find((e) => e.label === l.label) ?? { ...l, label: `MISSING ${l.label}` });
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  uiDelete(['railCollapsed', 'railWidth']);
});

afterEach(async () => {
  for (const r of roots) await act(async () => r.unmount());
  roots = [];
});

describe('right-clicking a session, in the left list and on the strip (issue 1168)', () => {
  it('is the short menu: four actions, then the groups it could move to', async () => {
    const { left } = await both([BACK, DOCS], 'scratch');
    expect(left.map((e) => e.label)).toEqual([
      i18next.t('rail.menuDiff'),
      i18next.t('rail.menuRename'),
      i18next.t('rail.menuPin'),
      i18next.t('rail.menuClose'),
      'Backend',
      'Docs',
      i18next.t('strip.menuNoGroup'),
    ]);
  });

  it('is the SAME menu in both places, for a loose session', async () => {
    const { left, top } = await both([BACK, DOCS], 'scratch');
    expect(left).toEqual(top);
    expect(left.find((e) => e.label === i18next.t('strip.menuNoGroup'))!.checked).toBe('true');
  });

  it('offers "Mark as seen" in the same place in both, and only for a finished session (#1219)', async () => {
    finishedIds = ['scratch'];
    try {
      const { left, top } = await both([BACK, DOCS], 'scratch');
      expect(left).toEqual(top);
      const labels = left.map((e) => e.label);
      const seen = labels.indexOf(i18next.t('rail.menuSeen'));
      expect(seen).toBeGreaterThan(-1);
      // straight after Close, before anything about groups
      expect(labels[seen - 1]).toBe(i18next.t('rail.menuClose'));
      // not offered for a session with nothing to mark
      const calm = await both([BACK, DOCS], 'api');
      expect(calm.left.map((e) => e.label)).not.toContain(i18next.t('rail.menuSeen'));
      expect(calm.top.map((e) => e.label)).not.toContain(i18next.t('rail.menuSeen'));
    } finally {
      finishedIds = [];
    }
  });

  it('is the same menu in both places for a session in a group, ticked at its group', async () => {
    const { left, top } = await both([BACK, DOCS], 'api');
    expect(left).toEqual(top);
    expect(left.find((e) => e.label === 'Backend')!.checked).toBe('true');
  });

  it('is the same with no groups at all: nothing about moving, in either', async () => {
    const { left, top } = await both([], 'scratch');
    expect(left).toEqual(top);
    expect(left).toHaveLength(4);
  });

  it('is the same for a session that never started: Rename dimmed, nothing about moving', async () => {
    const { left, top } = await both([BACK, DOCS], 'dud');
    expect(left).toEqual(top);
    expect(left).toHaveLength(4);
    expect(left.find((e) => e.label === i18next.t('rail.menuRename'))!.dimmed).toBe(true);
  });

  it('carries none of what was moved off it', async () => {
    const { left, top } = await both([BACK, DOCS], 'api');
    const words = [...left, ...top].map((e) => e.label);
    for (const gone of [
      'Move up',
      'Move down',
      'Keep visible',
      'Collapse on submit',
      'Hide on submit',
      'Always jump to it',
      'Never jump, just mark it',
    ]) {
      expect(words).not.toContain(gone);
    }
  });
});

describe('and on the session\'s tab in the workspace (issue 1281)', () => {
  const cases: [string, RailGroup[], string, string[]][] = [
    ['a loose session, with groups', [BACK, DOCS], 'scratch', []],
    ['a session in a group', [BACK, DOCS], 'api', []],
    ['no groups at all', [], 'scratch', []],
    ['a session that never started', [BACK, DOCS], 'dud', []],
    ['a finished session', [BACK, DOCS], 'scratch', ['scratch']],
  ];
  for (const [name, groups, id, done] of cases) {
    it(`carries every item the lists do, unchanged: ${name}`, async () => {
      finishedIds = done;
      try {
        const { left } = await both(groups, id);
        document.body.innerHTML = '';
        const tab = await tabMenu(groups, id);
        expect(sharedWith(left, tab)).toEqual(left);
        // and the move set keeps its order: your groups, then none
        const moves = (es: Entry[]): string[] =>
          es.filter((e) => e.checked !== null).map((e) => e.label);
        expect(moves(tab)).toEqual(moves(left));
      } finally {
        finishedIds = [];
      }
    });
  }

  it('is the tab\'s order: rename and duplicate first, close last', async () => {
    const tab = await tabMenu([BACK, DOCS], 'scratch');
    const labels = tab.map((e) => e.label);
    expect(labels[0]).toBe(i18next.t('rail.menuRename'));
    expect(labels[1]).toBe(i18next.t('tabMenu.duplicate'));
    expect(labels.at(-1)).toBe(i18next.t('rail.menuClose'));
    expect(labels.at(-2)).toBe(i18next.t('tabMenu.closeOthers'));
    // alone in its group: there are no others to close, so it is dimmed
    expect(tab.at(-2)!.dimmed).toBe(true);
    expect(labels).toContain(i18next.t('tabMenu.popOut'));
    expect(labels).toContain(i18next.t('tabMenu.copyPath'));
  });
});
