// Theme manager (§5.20, P2-E15-05). A theme is DATA: a base preset from
// tokens.css plus a map of token overrides painted onto <html>.
//
// WHY BASE + OVERLAY, and not "every theme is a full token map":
//  - tokens.css keeps the nordic/daylight presets, so those two need no map at
//    all — they are `{}` overlays on their own base. Colors stay in the one
//    file the raw-color lint rule guards.
//  - §5.20 promises the ten-token tweaker as much as the full-file author: with
//    a base to inherit from, a theme that only wants a different accent is a
//    two-line file instead of a 42-token fork.
//  - the CSS presets are also the FIRST PAINT. A map applied by JS can only
//    ever arrive after the document does; a base that is already correct means
//    the window never flashes the wrong theme on the way in.
//
// The engine takes its theme list as an ARGUMENT rather than reaching for the
// contribution registry: this module is the pure half and tests without one.
// App.tsx resolves the list from the registry once and passes it down.
import { isThemeToken, THEME_TOKENS } from './tokens';
import { uiGet, uiSet } from '../lib/ui-state';

/** A theme id. Persisted, so it is a contract — and an open one, since the ids
 *  are whatever is registered at the `theme` contribution point. */
export type ThemeId = string;

/**
 * What the user chose: a theme id, or the reserved id `'system'` to follow the
 * OS (see `RESERVED_THEME_IDS` in extensibility/themes.ts).
 *
 * An ALIAS of `ThemeId`, not `'system' | ThemeId`, because that union was a
 * lie (#255 T2). Theme ids are open — whatever the `theme` contribution point
 * registers — so `ThemeId` is `string`, and a union of a string literal with
 * `string` collapses to `string`: the `'system'` half looked like it was
 * checking something and was not (`pref = 'systm'` typed clean). The reserved
 * value is enforced where it actually can be, at runtime: `listThemes`
 * (extensibility/themes.ts) drops a contributed theme that claims the id and
 * says so on the console, and `loadPreference` below is the one place an
 * untrusted stored string becomes a preference at all.
 */
export type ThemePreference = ThemeId;

export interface ThemeDefinition {
  id: ThemeId;
  /** i18n key for the display name (§5.21) */
  nameKey: string;
  /** which tokens.css preset this theme starts from */
  base: 'nordic' | 'daylight';
  /**
   * light or dark, for the consumers that genuinely have only two options —
   * Monaco's `vs`/`vs-dark` and dockview's `colorScheme`. Declared rather than
   * derived from `base`, because an overlay is free to invert the preset it
   * builds on and only the theme's author knows which way it ended up.
   */
  colorScheme: 'light' | 'dark';
  /** the theme 'system' resolves to for that OS scheme, if any */
  systemDefault?: 'light' | 'dark';
  /** token -> CSS value; only names in THEME_TOKENS are applied */
  tokens: Readonly<Record<string, string>>;
}

// The workspace `ui` blob, NOT localStorage (P2-E15-06, AR-P0-3): the packaged
// renderer is served from a random loopback port, so its origin — and every
// localStorage bound to it — is a brand-new store on every launch. Measured
// 2026-07-31: launch 1 `http://127.0.0.1:58814`, launch 2
// `http://127.0.0.1:57029`, stored preference `null`. The theme picker worked
// and the choice evaporated at the door, every time.
const STORAGE_KEY = 'theme';

/**
 * Last resort when the registry is empty — a nothing-overlay on the preset
 * tokens.css already paints at `:root`. It is not a fourth theme: it is the
 * stylesheet's own default, named, so every caller gets a definition back and
 * nobody has to handle `undefined` on a cosmetic path (fail-open).
 */
export const FALLBACK_THEME: ThemeDefinition = {
  id: 'nordic',
  nameKey: 'theme.nordic',
  base: 'nordic',
  colorScheme: 'dark',
  systemDefault: 'dark',
  tokens: {},
};

export function systemColorScheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function findTheme(themes: readonly ThemeDefinition[], id: string): ThemeDefinition | undefined {
  return themes.find((t) => t.id === id);
}

/** The theme a preference resolves to right now. Never undefined — see FALLBACK_THEME. */
export function resolveTheme(pref: ThemePreference, themes: readonly ThemeDefinition[]): ThemeDefinition {
  if (pref !== 'system') {
    const chosen = findTheme(themes, pref);
    if (chosen) return chosen;
  }
  const scheme = systemColorScheme();
  return themes.find((t) => t.systemDefault === scheme) ?? themes[0] ?? FALLBACK_THEME;
}

/**
 * The stored preference, or 'system'.
 *
 * An id that no longer resolves falls back rather than sticking: themes are an
 * open set, so a theme can be uninstalled (or renamed) out from under a stored
 * preference, and a card-carrying "nothing looks right" bug is what you get if
 * that silently leaves the app painting a theme it cannot name.
 */
export function loadPreference(themes: readonly ThemeDefinition[]): ThemePreference {
  // sync by the time anything renders: main.tsx awaits the blob before the
  // first paint, precisely so the theme does not arrive a frame late
  const v = uiGet<string | null>(STORAGE_KEY, null);
  if (v === 'system') return 'system';
  return v && findTheme(themes, v) ? v : 'system';
}

/**
 * Paint a theme onto a document element.
 *
 * Every themeable token is REMOVED first, so switching away from a theme that
 * set `--panel` cannot leave that value behind on one that doesn't — an
 * overlay is not additive, and a half-cleared one is the worst of both themes.
 *
 * NAMES are checked against the enumerable list, so a theme cannot set an
 * arbitrary custom property, and values go through `setProperty` — the CSSOM
 * API — so a value cannot escape into the stylesheet as syntax. VALUES are NOT
 * otherwise validated: the maps are bundled at build time today, so they are
 * trusted code, and what contains a hostile value (`url(https://…)` in a token
 * that lands in `background`) is the CSP in `shared/csp.ts`, which is a different
 * subsystem. Before a theme can arrive from a user or a plugin this needs a
 * value check of its own — `tokens.ts` already says which tokens are colors
 * and which are shadows, which is the hook for it.
 */
export function applyTheme(
  def: ThemeDefinition,
  root: HTMLElement = document.documentElement
): ThemeDefinition {
  root.dataset.theme = def.base;
  root.dataset.themeId = def.id;
  root.dataset.colorScheme = def.colorScheme;
  for (const token of THEME_TOKENS) root.style.removeProperty(token);
  for (const [name, value] of Object.entries(def.tokens)) {
    if (!isThemeToken(name)) {
      // fail-open and say so: a theme with one bad key still applies the rest
      console.warn(`theme "${def.id}": ignoring unknown token ${name}`);
      continue;
    }
    root.style.setProperty(name, value);
  }
  return def;
}

/**
 * Resolve, paint and PERSIST — a deliberate choice by the user.
 *
 * Boot does not come through here: it calls `applyTheme(resolveTheme(…))`
 * instead, because writing back what was merely resolved would destroy the
 * stored preference the first time it fails to resolve. Theme ids are an open
 * set now, so "fails to resolve" is reachable with a perfectly valid
 * preference — a theme uninstalled, or a registry that came up short — and the
 * choice must come back with the theme rather than having been overwritten
 * with 'system' at the one boot that could not see it.
 */
export function applyPreference(
  pref: ThemePreference,
  themes: readonly ThemeDefinition[]
): ThemeDefinition {
  const def = applyTheme(resolveTheme(pref, themes));
  uiSet(STORAGE_KEY, pref); // fail-open inside: a failed write never costs the paint
  return def;
}

/**
 * Copy the active overlay onto another document's root.
 *
 * A popped-out window is a separate DOCUMENT: it shares the stylesheet (so the
 * base preset arrives with `data-theme`) but not our inline properties, so
 * without this a high-contrast app would have a nordic popout — the base right
 * and every override missing.
 */
export function copyThemeOverlay(from: HTMLElement, to: HTMLElement): void {
  for (const token of THEME_TOKENS) {
    const value = from.style.getPropertyValue(token);
    if (value) to.style.setProperty(token, value);
    else to.style.removeProperty(token);
  }
}

/** Wire OS-change following; returns an unsubscribe. */
export function followSystemTheme(
  themes: readonly ThemeDefinition[],
  onChange: (t: ThemeDefinition) => void
): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const handler = (): void => {
    // applyTheme, NOT applyPreference — following the OS is not a choice and
    // has nothing to persist. It matters because `loadPreference` returns
    // 'system' for two different reasons: the user picked it, or their stored
    // id did not resolve. Persisting here would destroy the second one on the
    // next OS light/dark flip, which is the boot-path bug in a slower form.
    if (loadPreference(themes) === 'system') onChange(applyTheme(resolveTheme('system', themes)));
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
