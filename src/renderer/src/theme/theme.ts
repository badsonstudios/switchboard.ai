// Theme manager (§5.20): default follows the OS; explicit user choice
// overrides and persists. Themes are whole token maps in tokens.css keyed by
// [data-theme] on <html>.
export type ThemeName = 'nordic' | 'daylight';
export type ThemePreference = ThemeName | 'system';

const STORAGE_KEY = 'switchboard.theme';

export function systemTheme(): ThemeName {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'daylight' : 'nordic';
}

export function loadPreference(): ThemePreference {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'nordic' || v === 'daylight' || v === 'system' ? v : 'system';
}

export function resolveTheme(pref: ThemePreference): ThemeName {
  return pref === 'system' ? systemTheme() : pref;
}

export function applyPreference(pref: ThemePreference): ThemeName {
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, pref);
  return theme;
}

/** Wire OS-change following; returns an unsubscribe. */
export function followSystemTheme(onChange: (t: ThemeName) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if (loadPreference() === 'system') onChange(applyPreference('system'));
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
