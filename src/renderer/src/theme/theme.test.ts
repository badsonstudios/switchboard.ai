// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyPreference,
  applyTheme,
  copyThemeOverlay,
  FALLBACK_THEME,
  findTheme,
  loadPreference,
  resolveTheme,
  ThemeDefinition,
} from './theme';
import { builtinThemes, tokensFromJson } from './builtin-themes';
import { loadUiState } from '../lib/ui-state';

// The preference lives in the workspace `ui` blob behind the preload bridge
// (P2-E15-06), so every test that touches it starts from a known blob. Set on
// the real jsdom window rather than replacing it: `matchMedia` lives on
// Window's prototype and a spread copy would lose it.
function stubBridge(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const state = { store: { ...initial } };
  (window as unknown as { switchboard: unknown }).switchboard = {
    workspace: {
      getUi: async () => state.store,
      setUi: (v: Record<string, unknown>) => {
        state.store = { ...v };
      },
    },
  };
  return state;
}

function mockSystemLight(light: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('light') ? light : !light,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

// A custom property takes almost any value, so the tests that only care THAT a
// value moved use a marker rather than a color — the raw-color lint rule
// applies to this file too, and it is one of the item's done-when criteria.
const SENTINEL = 'sentinel-value';

const themes = builtinThemes;
const nordic = findTheme(themes, 'nordic')!;
const daylight = findTheme(themes, 'daylight')!;
const highContrast = findTheme(themes, 'high-contrast')!;

function resetRoot(): void {
  const root = document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.themeId;
  delete root.dataset.colorScheme;
  root.removeAttribute('style');
}

describe('theme manager', () => {
  beforeEach(async () => {
    localStorage.clear();
    stubBridge();
    await loadUiState();
    resetRoot();
  });

  it('defaults to system preference', () => {
    expect(loadPreference(themes)).toBe('system');
  });

  it('resolves system to the OS scheme', () => {
    mockSystemLight(true);
    expect(resolveTheme('system', themes).id).toBe('daylight');
    mockSystemLight(false);
    expect(resolveTheme('system', themes).id).toBe('nordic');
  });

  it('applies and persists an explicit choice — in the ui blob, not localStorage', () => {
    mockSystemLight(false);
    const state = stubBridge();
    const t = applyPreference('daylight', themes);
    expect(t.id).toBe('daylight');
    expect(document.documentElement.dataset.theme).toBe('daylight');
    expect(loadPreference(themes)).toBe('daylight');
    // the packaged renderer's origin changes port every launch, so a
    // localStorage write would be gone by the next one (P2-E15-06)
    expect(state.store.theme).toBe('daylight');
    expect(localStorage.getItem('switchboard.theme')).toBeNull();
  });

  it('ignores corrupt storage', async () => {
    stubBridge({ theme: 'neon-vomit' });
    await loadUiState();
    expect(loadPreference(themes)).toBe('system');
  });

  it('migrates a preference from its old localStorage home', async () => {
    // dev keeps a stable origin, so a developer's stored choice is still there
    localStorage.setItem('switchboard.theme', 'daylight');
    stubBridge();
    await loadUiState();
    expect(loadPreference(themes)).toBe('daylight');
  });

  it('falls back rather than painting a theme it cannot name', async () => {
    // themes are an open set — one can be uninstalled out from under a stored
    // preference, and "nothing looks right" is what a silent miss looks like
    stubBridge({ theme: 'high-contrast' });
    await loadUiState();
    expect(loadPreference([nordic, daylight])).toBe('system');
  });

  it('does not DESTROY a preference it merely failed to resolve', async () => {
    mockSystemLight(false);
    const state = stubBridge({ theme: 'high-contrast' });
    await loadUiState();
    // boot's path: resolve and paint, never write back
    applyTheme(resolveTheme(loadPreference([nordic, daylight]), [nordic, daylight]));
    // the theme comes back when its contribution does; overwriting it with
    // 'system' here would lose the choice at the one boot that could not see it
    expect(state.store.theme).toBe('high-contrast');
  });

  it('survives a store that cannot be read', async () => {
    (window as unknown as { switchboard: unknown }).switchboard = {
      workspace: {
        getUi: async () => {
          throw new Error('bridge down');
        },
      },
    };
    await loadUiState();
    // this runs inside a useState initializer — a throw here blanks the window
    expect(() => loadPreference(themes)).not.toThrow();
    expect(loadPreference(themes)).toBe('system');
  });

  it('resolves to the stylesheet default when nothing is registered', () => {
    mockSystemLight(false);
    // a broken registry must cost the theme PICKER, never the paint
    expect(resolveTheme('nordic', []).id).toBe(FALLBACK_THEME.id);
    // and the hand-written fallback must not drift from the theme it stands in
    // for — comparing it to itself would prove nothing
    expect(FALLBACK_THEME).toEqual(nordic);
  });
});

describe('a theme is a token map', () => {
  beforeEach(resetRoot);

  it('paints its base preset, its id and its light/dark verdict', () => {
    applyTheme(highContrast);
    const d = document.documentElement.dataset;
    expect(d.theme).toBe('nordic'); // the preset it builds on
    expect(d.themeId).toBe('high-contrast'); // what the user actually chose
    expect(d.colorScheme).toBe('dark');
  });

  it('applies the map as custom properties', () => {
    applyTheme(highContrast);
    // asserted against the FILE, never against a color spelled here: the theme
    // owns its values, and the raw-color lint rule owns this file
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe(
      highContrast.tokens['--bg']
    );
  });

  it('CLEARS the previous map when switching away', () => {
    applyTheme(highContrast);
    applyTheme(daylight);
    // EVERY token, not just --bg: narrowing the clear loop to the layer-1 map
    // would leave every semantic override (--status-*, --diff-*, --link)
    // bleeding into a theme that never asked for it, and a one-token
    // assertion would not notice
    for (const token of Object.keys(highContrast.tokens)) {
      expect(document.documentElement.style.getPropertyValue(token), token).toBe('');
    }
    expect(document.documentElement.dataset.theme).toBe('daylight');
  });

  it('ignores a token that is not themeable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rogue: ThemeDefinition = {
      ...nordic,
      id: 'rogue',
      tokens: { '--accent-teal': SENTINEL, '--bg': SENTINEL },
    };
    applyTheme(rogue);
    const style = document.documentElement.style;
    // session identity is not a theme's to repaint (§5.20)
    expect(style.getPropertyValue('--accent-teal')).toBe('');
    expect(style.getPropertyValue('--bg')).toBe(SENTINEL);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('copies the overlay to another document root, stale tokens included', () => {
    const other = document.createElement('html');
    // a popout still holding an old theme's value when the app went nordic
    other.style.setProperty('--bg', SENTINEL);
    applyTheme(nordic);
    copyThemeOverlay(document.documentElement, other);
    expect(other.style.getPropertyValue('--bg')).toBe('');

    applyTheme(highContrast);
    copyThemeOverlay(document.documentElement, other);
    expect(other.style.getPropertyValue('--bg')).toBe(highContrast.tokens['--bg']);
  });
});

describe('built-in themes', () => {
  it('ships four, each with a distinct id', () => {
    expect(themes).toHaveLength(4);
    expect(new Set(themes.map((t) => t.id)).size).toBe(4);
  });

  it('keeps the presets as bases with no map of their own', () => {
    expect(nordic.tokens).toEqual({});
    expect(daylight.tokens).toEqual({});
  });

  it('drops metadata keys but keeps tokens', () => {
    expect(tokensFromJson({ $comment: 'why', '--bg': SENTINEL, nested: { a: 1 } })).toEqual({
      '--bg': SENTINEL,
    });
  });

  it('gives exactly one theme per system scheme', () => {
    expect(themes.filter((t) => t.systemDefault === 'dark')).toHaveLength(1);
    expect(themes.filter((t) => t.systemDefault === 'light')).toHaveLength(1);
  });
});
