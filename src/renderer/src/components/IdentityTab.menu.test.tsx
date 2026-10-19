// @vitest-environment jsdom
// Right-clicking a tab in the workspace (#1281).
//
// `session-menu-parity.test.tsx` holds the session items to the lists' answer.
// This file is what is the TAB's own: which menu each kind of tab gets, that
// the keyboard reaches it, and that its items do what they say — Rename in the
// tab, Duplicate through the naming step, Close others behind one question.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { IdentityTab, type CardParams } from './SessionGrid';
import { sessionStore } from '../store/session-store';
import { SessionMenuActions, SessionMenuActionsContext } from '../lib/session-menu';
import type { IDockviewPanelProps } from 'dockview-react';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
/** dockview's own tab element, which the component is drawn inside */
let dvTab: HTMLElement;
let actions: SessionMenuActions & { [K in keyof Required<SessionMenuActions>]: ReturnType<typeof vi.fn> };

const FOLDER = 'C:\\Projects\\acme';

interface FakePanel {
  id: string;
  params?: Partial<CardParams>;
  api: { close: ReturnType<typeof vi.fn> };
}

function panel(id: string, params?: Partial<CardParams>): FakePanel {
  return { id, params, api: { close: vi.fn() } };
}

async function mount(opts: {
  id: string;
  params?: Partial<CardParams>;
  others?: FakePanel[];
  popout?: boolean;
  tabLocation?: string;
}): Promise<{ close: ReturnType<typeof vi.fn>; group: unknown }> {
  const close = vi.fn();
  const self = { id: opts.id, params: opts.params, api: { close } };
  const group = { panels: [self, ...(opts.others ?? [])] };
  const props = {
    api: {
      id: opts.id,
      title: 'acme',
      close,
      group,
      location: opts.popout ? { type: 'popout', getWindow: () => window } : { type: 'grid' },
    },
    containerApi: {},
    params: opts.params,
    ...(opts.tabLocation ? { tabLocation: opts.tabLocation } : {}),
  } as unknown as IDockviewPanelProps<CardParams>;
  await act(async () => {
    root!.render(
      <SessionMenuActionsContext.Provider value={actions}>
        <IdentityTab {...props} />
      </SessionMenuActionsContext.Provider>
    );
  });
  return { close, group };
}

const menu = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="tab-menu"]');
const labels = (): string[] =>
  Array.from(menu()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []).map((el) =>
    (el.textContent ?? '').replace('✓', '').trim()
  );
const item = (label: string): HTMLElement =>
  Array.from(menu()!.querySelectorAll<HTMLElement>('[role^="menuitem"]')).find(
    (el) => (el.textContent ?? '').trim() === label
  )!;

async function rightClick(el: HTMLElement, at = { x: 30, y: 10 }): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y })
    );
  });
}

async function choose(label: string): Promise<void> {
  await act(async () => item(label).click());
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  dvTab = document.createElement('div');
  dvTab.className = 'dv-tab';
  dvTab.tabIndex = 0;
  document.body.appendChild(dvTab);
  root = createRoot(dvTab);
  actions = {
    rename: vi.fn(),
    diff: vi.fn(),
    moveToGroup: vi.fn(),
    togglePin: vi.fn(),
    askName: vi.fn(() => Promise.resolve()),
  };
  sessionStore.setSessions([{ id: 'c1', title: 'acme', folder: FOLDER, status: 'idle', groupId: 'g1' }]);
  sessionStore.setGroups([{ id: 'g1', name: 'Backend', color: 'var(--status-working)' }]);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  sessionStore.setSessions([]);
  sessionStore.setGroups([]);
  vi.restoreAllMocks();
});

const SESSION = { cardId: 'c1', folder: FOLDER, title: 'acme' };

describe('a session tab\'s menu (issue 1281)', () => {
  it('opens on a right-click, and the browser\'s own menu does not', async () => {
    await mount({ id: 'session-c1', params: SESSION });
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 10 });
    await act(async () => {
      dvTab.querySelector('.identity-tab')!.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    expect(labels()).toContain(i18next.t('tabMenu.duplicate'));
  });

  it('is reached from the keyboard: Shift+F10 on the focused tab opens it under the tab', async () => {
    await mount({ id: 'session-c1', params: SESSION });
    // the keyboard's menu is fired at dockview's tab, ABOVE this component, at (0, 0)
    await rightClick(dvTab, { x: 0, y: 0 });
    expect(menu()).not.toBeNull();
    // Escape hands the keyboard back to the tab
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(dvTab);
  });

  it('is not opened from a row of the overflow drop-down', async () => {
    await mount({ id: 'session-c1', params: SESSION, tabLocation: 'headerOverflow' });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    expect(menu()).toBeNull();
  });

  it('Rename opens a box IN the tab, and Enter saves through the same rename as the lists', async () => {
    await mount({ id: 'session-c1', params: SESSION });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    await choose(i18next.t('rail.menuRename'));
    const input = dvTab.querySelector<HTMLInputElement>('[data-tab-rename="c1"] input')!;
    expect(input).not.toBeNull();
    expect(input.value).toBe('acme');
    await act(async () => {
      // the native setter, so React sees a change it did not make itself
      Reflect.set(HTMLInputElement.prototype, 'value', '  billing  ', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(actions.rename).toHaveBeenCalledWith('c1', 'billing');
    expect(dvTab.querySelector('[data-tab-rename]')).toBeNull();
  });

  it('a rename ended with Esc hands the keyboard back to the tab; a click away keeps it where it went', async () => {
    await mount({ id: 'session-c1', params: SESSION });
    const startRename = async (): Promise<HTMLInputElement> => {
      await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
      await choose(i18next.t('rail.menuRename'));
      return dvTab.querySelector<HTMLInputElement>('[data-tab-rename] input')!;
    };
    const settle = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 5)));
    let input = await startRename();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(document.activeElement).toBe(dvTab);

    const elsewhere = document.createElement('textarea');
    document.body.appendChild(elsewhere);
    input = await startRename();
    await act(async () => elsewhere.focus());
    await settle();
    expect(dvTab.querySelector('[data-tab-rename]')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    expect(actions.rename).not.toHaveBeenCalled();
  });

  it('Rename is dimmed, not hidden, for a session that never started', async () => {
    sessionStore.setSessions([{ id: 'c1', title: 'acme', folder: FOLDER, status: 'not-started' }]);
    await mount({ id: 'session-c1', params: SESSION });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    expect(item(i18next.t('rail.menuRename')).getAttribute('aria-disabled')).toBe('true');
    await choose(i18next.t('rail.menuRename'));
    expect(dvTab.querySelector('[data-tab-rename]')).toBeNull();
  });

  it('Duplicate asks for a name for a NEW session in the same folder, group and tab group', async () => {
    const { group } = await mount({ id: 'session-c1', params: SESSION });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    await choose(i18next.t('tabMenu.duplicate'));
    expect(actions.askName).toHaveBeenCalledWith(FOLDER, { into: group, groupId: 'g1' });
  });

  it('offers no Fork while the card has no conversation to fork from', async () => {
    await mount({ id: 'session-c1', params: SESSION });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    expect(labels()).not.toContain(i18next.t('tabMenu.fork'));
  });

  it('says "Return to main window" when the tab is popped out', async () => {
    await mount({ id: 'session-c1', params: SESSION, popout: true });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    expect(labels()).toContain(i18next.t('tabMenu.dockIn'));
    expect(labels()).not.toContain(i18next.t('tabMenu.popOut'));
  });

  it('Close other tabs asks once when a session would end, then closes them all', async () => {
    const other = panel('session-c2', { cardId: 'c2' });
    const doc = panel('doc-1');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { close } = await mount({ id: 'session-c1', params: SESSION, others: [other, doc] });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    await choose(i18next.t('tabMenu.closeOthers'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(other.api.close).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    await choose(i18next.t('tabMenu.closeOthers'));
    expect(other.api.close).toHaveBeenCalledTimes(1);
    expect(doc.api.close).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled(); // never this one
  });

  it('Close session asks first, as the ✕ does', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { close } = await mount({ id: 'session-c1', params: SESSION });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    await choose(i18next.t('rail.menuClose'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('a tab with no session behind it (issue 1281)', () => {
  it('a document gets the short menu: Close, Close others, Pop out — nothing about sessions', async () => {
    await mount({ id: 'doc-1' });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    expect(labels()).toEqual([
      i18next.t('tabMenu.close'),
      i18next.t('tabMenu.closeOthers'),
      i18next.t('tabMenu.popOut'),
    ]);
  });

  it('a session\'s Changes tab has no window of its own to go to, so no Pop out', async () => {
    await mount({ id: 'diff-c1' });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    expect(labels()).toEqual([i18next.t('tabMenu.close'), i18next.t('tabMenu.closeOthers')]);
  });

  it('Close closes it with no question', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { close } = await mount({ id: 'doc-1' });
    await rightClick(dvTab.querySelector<HTMLElement>('.identity-tab')!);
    await choose(i18next.t('tabMenu.close'));
    expect(confirm).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
