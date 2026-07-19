import React, { useEffect, useState } from 'react';
import {
  applyPreference,
  followSystemTheme,
  loadPreference,
  ThemeName,
  ThemePreference,
} from './theme/theme';
import { LanguageChoice, loadLanguage, setLanguage } from './i18n';
import { TitleBar, SessionsRail, StatusBar, RailSession } from './components/chrome';
import { SessionGrid, GridController } from './components/SessionGrid';
import { FeedPanel } from './components/FeedPanel';

// Control-room shell (P1-E3-01): titlebar / rail / grid / statusbar.
// Terminals (E3-02), identity kit (E3-03), and live badges (E3-05) land next.
export function App(): React.JSX.Element {
  // fail-open: a broken preload bridge must degrade, not blank the window
  const bridge =
    window.switchboard ??
    ({
      platform: 'bridge unavailable',
      appVersion: '?',
      seedPanels: 0,
      seedSessionFolder: '',
      workspace: { getLayout: async () => null, setLayout: () => {} },
    } as unknown as typeof window.switchboard);
  const [pref, setPref] = useState<ThemePreference>(() => loadPreference());
  const [theme, setTheme] = useState<ThemeName>(() => applyPreference(loadPreference()));
  const [lang, setLang] = useState<LanguageChoice>(() => loadLanguage());
  const [cards, setCards] = useState<string[]>([]);
  const [sessions, setSessions] = useState<RailSession[]>([]);
  const [notifEnabled, setNotifEnabled] = useState(true);
  const grid = React.useRef<GridController | null>(null);

  useEffect(() => {
    void bridge.notifications?.getPrefs?.().then((p) => setNotifEnabled(p.enabled));
    // eslint's exhaustive-deps plugin isn't installed; bridge is stable
  }, []);

  useEffect(() => followSystemTheme(setTheme), []);

  // drag-a-folder-onto-window -> running session (E3-04)
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const p = window.switchboard.pathForFile(file);
      if (!p) return;
      void window.switchboard.sessions.isDirectory(p).then((isDir) => {
        if (isDir) void grid.current?.addSessionCard(p);
      });
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const refreshSessions = React.useCallback(async () => {
    const list = await bridge.sessions?.list?.();
    if (!list) return;
    setSessions(
      list.map((s) => ({
        id: s.id,
        title: s.identity.title,
        accent: s.identity.accentColor,
        badge: s.identity.langBadge,
        status: s.status,
      }))
    );
  }, []); // bridge is stable for the window's lifetime

  useEffect(() => {
    void refreshSessions();
    const off = bridge.sessions?.onStatus?.(() => void refreshSessions());
    return off;
  }, [cards, refreshSessions]); // re-sync when the grid's cards change

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
        notifEnabled={notifEnabled}
        onToggleNotif={() => {
          const next = !notifEnabled;
          setNotifEnabled(next);
          void bridge.notifications?.setPrefs?.({ enabled: next });
        }}
      />
      <div style={{ flex: 1, display: 'flex', minBlockSize: 0 }}>
        <SessionsRail
          sessions={sessions}
          onRename={(id, title) => {
            void bridge.sessions?.rename?.(id, title).then(() => refreshSessions());
          }}
          onFocus={(id) => grid.current?.focusSession(id)}
        />
        <SessionGrid
          theme={theme}
          seedPanels={bridge.seedPanels ?? 0}
          onCardsChanged={setCards}
          controller={grid}
        />
        <FeedPanel sessions={sessions} onFocus={(id) => grid.current?.focusSession(id)} />
      </div>
      <StatusBar count={cards.length} theme={theme} />
    </div>
  );
}
