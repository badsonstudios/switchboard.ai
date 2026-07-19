import React, { useEffect, useState } from 'react';
import {
  applyPreference,
  followSystemTheme,
  loadPreference,
  ThemeName,
  ThemePreference,
} from './theme/theme';
import { LanguageChoice, loadLanguage, setLanguage } from './i18n';
import { TitleBar, SessionsRail, StatusBar } from './components/chrome';
import { SessionGrid } from './components/SessionGrid';

// Control-room shell (P1-E3-01): titlebar / rail / grid / statusbar.
// Terminals (E3-02), identity kit (E3-03), and live badges (E3-05) land next.
export function App(): React.JSX.Element {
  // fail-open: a broken preload bridge must degrade, not blank the window
  const bridge = window.switchboard ?? {
    platform: 'bridge unavailable',
    appVersion: '?',
    seedPanels: 0,
    workspace: { getLayout: async () => null, setLayout: () => {} },
  };
  const [pref, setPref] = useState<ThemePreference>(() => loadPreference());
  const [theme, setTheme] = useState<ThemeName>(() => applyPreference(loadPreference()));
  const [lang, setLang] = useState<LanguageChoice>(() => loadLanguage());
  const [cards, setCards] = useState<string[]>([]);

  useEffect(() => followSystemTheme(setTheme), []);

  return (
    <div style={{ blockSize: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TitleBar
        version={bridge.appVersion}
        pref={pref}
        onTheme={(p) => {
          setPref(p);
          setTheme(applyPreference(p));
        }}
        lang={lang}
        onLang={(l) => {
          setLang(l);
          void setLanguage(l);
        }}
      />
      <div style={{ flex: 1, display: 'flex', minBlockSize: 0 }}>
        <SessionsRail cards={cards} />
        <SessionGrid theme={theme} seedPanels={bridge.seedPanels ?? 0} onCardsChanged={setCards} />
      </div>
      <StatusBar count={cards.length} theme={theme} />
    </div>
  );
}
