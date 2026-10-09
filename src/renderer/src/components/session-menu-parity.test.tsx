// @vitest-environment jsdom
// ONE session menu, in both places (#1168).
//
// Right-clicking a session gave a long menu in the list on the left and a short
// one on the strip across the top. The owner picked the short one for both.
// This file mounts both lists over the same sessions and groups and holds them
// to the same answer, so the next item added to one has to be added to the
// other, or this goes red.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsRail } from './SessionsRail';
import { SessionsStrip } from './SessionsStrip';
import { DEFAULT_BOOK } from '../lib/presentation-policy';
import { uiDelete } from '../lib/ui-state';
import { NO_ORDER } from '../lib/rail-order';
import { railOrder } from '../lib/groups';
import { RailGroup, RailSession } from '../model/types';

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
        palette={['var(--status-working)']}
        policies={DEFAULT_BOOK}
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
        onCycleGroupPolicy={noop}
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
