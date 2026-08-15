// The right-click menu's decision, per surface class (#526).
//
// No Electron, no DOM: `buildContextMenuTemplate` takes the slice of
// `ContextMenuParams` that matters and returns plain data, which is the whole
// reason it is a separate function from the listener that calls it.
import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow, Menu, MenuItemConstructorOptions, WebContents } from 'electron';
import {
  buildContextMenuTemplate,
  installContextMenu,
  makeContextMenuDeps,
  sanitizeContextMenuLabels,
  ContextMenuSurface,
  DEFAULT_CONTEXT_MENU_LABELS,
} from './context-menu';

const L = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' };

function surface(
  over: Partial<Omit<ContextMenuSurface, 'editFlags'>> & {
    editFlags?: Partial<ContextMenuSurface['editFlags']>;
  } = {}
): ContextMenuSurface {
  const { editFlags, ...rest } = over;
  return {
    isEditable: false,
    selectionText: '',
    x: 40,
    y: 60,
    ...rest,
    editFlags: {
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
      ...(editFlags ?? {}),
    },
  };
}

/** roles in order, separators as '-' */
function shape(t: MenuItemConstructorOptions[]): string[] {
  return t.map((i) => (i.type === 'separator' ? '-' : String(i.role)));
}

describe('buildContextMenuTemplate — editable surfaces (the composer)', () => {
  it('offers the whole edit menu', () => {
    const t = buildContextMenuTemplate(
      surface({
        isEditable: true,
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      }),
      L
    );
    expect(shape(t)).toEqual(['cut', 'copy', 'paste', '-', 'selectAll']);
    expect(t.map((i) => i.label)).toEqual(['Cut', 'Copy', 'Paste', undefined, 'Select All']);
  });

  it('PASTE IS ALWAYS THERE, and enabled from Chromium\'s own flag', () => {
    // The one item the issue exists for: pasting an image into the composer has
    // to be reachable from the mouse, and it rides `role: 'paste'` so that
    // Chromium fires the same trusted `paste` event Ctrl+V does — the event the
    // attachment pipeline (#475) turns into a chip. An item we enabled
    // ourselves, or a click handler that read the clipboard in the renderer,
    // would be a second path that could rot away from the first.
    const on = buildContextMenuTemplate(
      surface({ isEditable: true, editFlags: { canPaste: true } }),
      L
    );
    expect(on.find((i) => i.role === 'paste')?.enabled).toBe(true);
    const off = buildContextMenuTemplate(surface({ isEditable: true }), L);
    // greyed, NOT missing: a menu whose items appear and vanish teaches nobody
    // what the surface can do (§5.8)
    expect(off.find((i) => i.role === 'paste')).toBeDefined();
    expect(off.find((i) => i.role === 'paste')?.enabled).toBe(false);
  });

  it('follows editFlags item by item — an empty box greys Cut and Copy', () => {
    const t = buildContextMenuTemplate(
      surface({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: false },
      }),
      L
    );
    const enabled = Object.fromEntries(
      t.filter((i) => i.role).map((i) => [String(i.role), i.enabled])
    );
    expect(enabled).toEqual({ cut: false, copy: false, paste: true, selectAll: false });
  });
});

describe('buildContextMenuTemplate — non-editable surfaces (feed, viewer)', () => {
  it('offers Copy alone when something is selected', () => {
    const t = buildContextMenuTemplate(
      surface({ selectionText: 'a line from the feed', editFlags: { canCopy: true } }),
      L
    );
    expect(shape(t)).toEqual(['copy']);
    expect(t[0].label).toBe('Copy');
    expect(t[0].enabled).toBe(true);
  });

  it('offers NOTHING with no selection — no menu beats a menu of dead items', () => {
    expect(buildContextMenuTemplate(surface(), L)).toEqual([]);
  });

  it('treats whitespace as no selection', () => {
    expect(buildContextMenuTemplate(surface({ selectionText: '  \n\t ' }), L)).toEqual([]);
  });

  it('never offers Cut or Paste on read-only text', () => {
    const t = buildContextMenuTemplate(
      surface({ selectionText: 'x', editFlags: { canCopy: true, canPaste: true } }),
      L
    );
    expect(t.some((i) => i.role === 'cut' || i.role === 'paste')).toBe(false);
  });

  it('offers nothing when the selection cannot be copied', () => {
    // A one-item menu whose one item is greyed is the "menu of dead items" the
    // empty answer exists to avoid — so `canCopy` gates the branch, not just
    // the item. This is also the shape a terminal produces: xterm paints its
    // own selection rather than making a DOM one, so a right-click there
    // reaches here and gets nothing, which is how "the terminal is out of
    // scope" is enforced without a terminal-shaped guard.
    const t = buildContextMenuTemplate(
      surface({ selectionText: 'x', editFlags: { canCopy: false, canSelectAll: true } }),
      L
    );
    expect(t).toEqual([]);
  });
});

describe('sanitizeContextMenuLabels', () => {
  it('takes four good strings', () => {
    const l = { cut: 'Couper', copy: 'Copier', paste: 'Coller', selectAll: 'Tout sélectionner' };
    expect(sanitizeContextMenuLabels(l)).toEqual(l);
  });

  it('falls back PER KEY, so one bad string costs one word', () => {
    const l = sanitizeContextMenuLabels({ cut: 'Couper', copy: 42, paste: '', selectAll: null });
    expect(l).toEqual({
      cut: 'Couper',
      copy: DEFAULT_CONTEXT_MENU_LABELS.copy,
      paste: DEFAULT_CONTEXT_MENU_LABELS.paste,
      selectAll: DEFAULT_CONTEXT_MENU_LABELS.selectAll,
    });
  });

  it('refuses an over-long label and flattens newlines', () => {
    const l = sanitizeContextMenuLabels({ cut: 'a'.repeat(400), copy: 'Co\npy' });
    expect(l.cut).toBe(DEFAULT_CONTEXT_MENU_LABELS.cut);
    expect(l.copy).toBe('Co py');
  });

  it('survives junk entirely', () => {
    expect(sanitizeContextMenuLabels(null)).toEqual(DEFAULT_CONTEXT_MENU_LABELS);
    expect(sanitizeContextMenuLabels('nope')).toEqual(DEFAULT_CONTEXT_MENU_LABELS);
  });
});

describe('makeContextMenuDeps', () => {
  function wiring(win: Partial<BrowserWindow> | null) {
    const popup = vi.fn();
    const build = vi.fn(() => ({ popup }) as unknown as Menu);
    const deps = makeContextMenuDeps({
      labels: () => L,
      windowFor: () => win as BrowserWindow | null,
      build,
    });
    return { deps, build, popup };
  }

  it('anchors the menu to the CLICK, not to wherever the mouse is', () => {
    // `context-menu` also fires for Shift+F10 and the Context Menu key, and for
    // those Electron's default (the cursor's position) can be on another
    // monitor entirely. The rail's own menu learned this the same way.
    const w = { isDestroyed: () => false };
    const { deps, popup } = wiring(w);
    deps.popup([{ role: 'copy' }], {} as WebContents, { x: 12, y: 34 });
    expect(popup).toHaveBeenCalledWith({ window: w, x: 12, y: 34 });
  });

  it('shows NOTHING when the window that produced the event has gone', () => {
    // `menu.popup()` with no window falls back to the focused window and then
    // to `getAllWindows()[0]` — a native Cut/Copy/Paste over a window nobody
    // right-clicked, whose roles then act on whatever is focused.
    for (const win of [null, { isDestroyed: () => true }]) {
      const { deps, build, popup } = wiring(win);
      deps.popup([{ role: 'copy' }], {} as WebContents, { x: 1, y: 2 });
      expect(popup).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled(); // not even built
    }
  });
});

describe('installContextMenu', () => {
  function fakeContents() {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    return {
      on: (name: string, h: (...a: unknown[]) => void) => {
        handlers[name] = h;
      },
      fire: (params: ContextMenuSurface) => handlers['context-menu']?.({}, params),
    };
  }

  it('pops up for an editable surface and stays silent for a bare click', () => {
    const c = fakeContents();
    const popup = vi.fn();
    installContextMenu(c as unknown as WebContents, { labels: () => L, popup });
    c.fire(surface({ isEditable: true, x: 7, y: 9, editFlags: { canPaste: true } }));
    expect(popup).toHaveBeenCalledTimes(1);
    expect(shape(popup.mock.calls[0][0] as MenuItemConstructorOptions[])).toContain('paste');
    // the click's own coordinates travel with it
    expect(popup.mock.calls[0][2]).toEqual({ x: 7, y: 9 });
    c.fire(surface());
    expect(popup).toHaveBeenCalledTimes(1); // still one: nothing to offer
  });

  it('reads the labels PER CLICK, so a language change lands without a reload', () => {
    const c = fakeContents();
    const popup = vi.fn();
    let labels = L;
    installContextMenu(c as unknown as WebContents, { labels: () => labels, popup });
    labels = { ...L, paste: 'Coller' };
    c.fire(surface({ isEditable: true }));
    const t = popup.mock.calls[0][0] as MenuItemConstructorOptions[];
    expect(t.find((i) => i.role === 'paste')?.label).toBe('Coller');
  });

  it('a throwing popup costs one right-click, not the window', () => {
    const c = fakeContents();
    const onError = vi.fn();
    installContextMenu(c as unknown as WebContents, {
      labels: () => L,
      popup: () => {
        throw new Error('no menu today');
      },
      onError,
    });
    expect(() => c.fire(surface({ isEditable: true }))).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
