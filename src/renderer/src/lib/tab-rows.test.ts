// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyTabRows, loadTabRows, toggleTabRows } from './tab-rows';
import { loadUiState } from './ui-state';

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
