// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyTabRows, loadTabRows, syncDocumentFlags, toggleTabRows } from './tab-rows';
import { loadUiState } from './ui-state';
import { addPopoutWindow, removePopoutWindow, resetPopoutWindows } from './popout-windows';
import { applyTheme, findTheme } from '../theme/theme';
import { builtinThemes } from '../theme/builtin-themes';

// the ui blob lives behind the preload bridge; stand in for it
function stubBridge(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const state = { store: { ...initial } };
  vi.stubGlobal('window', {
    ...globalThis.window,
    switchboard: {
      workspace: {
        getUi: async () => state.store,
        setUi: (v: Record<string, unknown>) => {
          state.store = { ...v };
        },
      },
    },
  });
  return state;
}

describe('tab rows (#84)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-tab-rows');
  });

  it('defaults to wrapping — sessions behind a dropdown is the wrong default', async () => {
    stubBridge();
    await loadUiState();
    expect(loadTabRows()).toBe('wrap');
  });

  it('reads a stored preference back', async () => {
    stubBridge({ tabRows: 'single' });
    await loadUiState();
    expect(loadTabRows()).toBe('single');
  });

  it('an unrecognized stored value falls back to wrapping', async () => {
    stubBridge({ tabRows: 'sideways' });
    await loadUiState();
    expect(loadTabRows()).toBe('wrap');
  });

  it('paints the mode onto <html> for the CSS (and the popout documents) to read', () => {
    applyTabRows('single');
    expect(document.documentElement.dataset.tabRows).toBe('single');
    applyTabRows('wrap');
    expect(document.documentElement.dataset.tabRows).toBe('wrap');
  });

  it('toggling flips, paints, and persists', async () => {
    const state = stubBridge();
    await loadUiState();
    expect(toggleTabRows()).toBe('single');
    expect(document.documentElement.dataset.tabRows).toBe('single');
    expect(state.store.tabRows).toBe('single');
    expect(toggleTabRows()).toBe('wrap');
    expect(state.store.tabRows).toBe('wrap');
  });
});

describe('syncDocumentFlags (#84 + P2-E15-05)', () => {
  /** a stand-in popout: its own document root, nothing shared with ours */
  function fakeWindow(): { window: Window; root: HTMLElement } {
    const root = document.createElement('html');
    return { window: { document: { documentElement: root } } as unknown as Window, root };
  }

  beforeEach(() => {
    resetPopoutWindows(); // module state, and this describe puts windows in it
    const root = document.documentElement;
    root.removeAttribute('style');
    delete root.dataset.themeId;
    delete root.dataset.colorScheme;
  });

  it('carries the flags AND the token overlay across', () => {
    const { window: win, root } = fakeWindow();
    applyTheme(findTheme(builtinThemes, 'high-contrast')!);
    applyTabRows('single');
    syncDocumentFlags([win]);
    expect(root.dataset.theme).toBe('nordic'); // the base preset
    expect(root.dataset.themeId).toBe('high-contrast');
    expect(root.dataset.colorScheme).toBe('dark');
    expect(root.dataset.tabRows).toBe('single');
    // the flags alone would leave a popout on the base with every override
    // missing — which looks exactly like a theme that half-applied
    expect(root.style.getPropertyValue('--bg')).toBe(
      document.documentElement.style.getPropertyValue('--bg')
    );
  });

  it('clears an overlay the app has switched away from', () => {
    const { window: win, root } = fakeWindow();
    applyTheme(findTheme(builtinThemes, 'high-contrast')!);
    syncDocumentFlags([win]);
    applyTheme(findTheme(builtinThemes, 'daylight')!);
    syncDocumentFlags([win]);
    expect(root.style.getPropertyValue('--bg')).toBe('');
    expect(root.dataset.theme).toBe('daylight');
  });

  it('reaches every open popout when called with no argument', () => {
    // what a theme switch does (App has no list of its own to hand it): the
    // default comes from the shared registry, so a popout that opened before
    // the switch is not left on the old theme (#227)
    const { window: win, root } = fakeWindow();
    addPopoutWindow(win);
    applyTheme(findTheme(builtinThemes, 'daylight')!);
    applyTabRows('single');
    syncDocumentFlags();
    expect(root.dataset.theme).toBe('daylight');
    expect(root.dataset.tabRows).toBe('single');

    // and a window the registry has forgotten is no longer written to
    removePopoutWindow(win);
    applyTheme(findTheme(builtinThemes, 'high-contrast')!);
    syncDocumentFlags();
    expect(root.dataset.theme).toBe('daylight');
  });

  it('fails open on a window that died mid-iteration', () => {
    const dead = { get document(): Document {
      throw new Error('window closed');
    } } as unknown as Window;
    const { window: alive, root } = fakeWindow();
    applyTheme(findTheme(builtinThemes, 'daylight')!);
    // the dead one must not cost the live one its theme — this is cosmetic
    // work and it never gets to throw into a caller
    expect(() => syncDocumentFlags([dead, alive])).not.toThrow();
    expect(root.dataset.theme).toBe('daylight');
  });
});
