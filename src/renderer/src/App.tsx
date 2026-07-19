import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyPreference,
  followSystemTheme,
  loadPreference,
  ThemeName,
  ThemePreference,
} from './theme/theme';
import { LanguageChoice, loadLanguage, setLanguage } from './i18n';

// Scaffold shell — real layout arrives with P1-E3-01. The theme + language
// toggles prove live token flips (E1-03) and pseudo-locale mangling (E1-04).
export function App(): React.JSX.Element {
  const { t } = useTranslation();
  // fail-open: a broken preload bridge must degrade, not blank the window
  const bridge = window.switchboard ?? { platform: 'bridge unavailable', appVersion: '?' };
  const [pref, setPref] = useState<ThemePreference>(() => loadPreference());
  const [theme, setTheme] = useState<ThemeName>(() => applyPreference(loadPreference()));
  const [lang, setLang] = useState<LanguageChoice>(() => loadLanguage());

  useEffect(() => followSystemTheme(setTheme), []);

  const chooseTheme = (next: ThemePreference): void => {
    setPref(next);
    setTheme(applyPreference(next));
  };
  const chooseLang = (next: LanguageChoice): void => {
    setLang(next);
    void setLanguage(next);
  };

  const chipStyle = (selected: boolean): React.CSSProperties => ({
    background: selected ? 'var(--chip)' : 'var(--panel)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '4px 12px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
  });

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontWeight: 300 }}>{t('app.title')}</h1>
        <p style={{ color: 'var(--muted)' }}>
          {t('shell.scaffoldStatus', {
            platform: bridge.platform,
            version: bridge.appVersion,
            theme,
            pref,
          })}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          {(['system', 'nordic', 'daylight'] as const).map((p) => (
            <button key={p} onClick={() => chooseTheme(p)} style={chipStyle(p === pref)}>
              {t(`theme.${p}`)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBlockStart: 8 }}>
          {(['en', 'pseudo'] as const).map((l) => (
            <button key={l} onClick={() => chooseLang(l)} style={chipStyle(l === lang)}>
              {t(`language.${l}`)}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
