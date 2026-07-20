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
  const [autonomy, setAutonomy] = useState<string>(
    () => localStorage.getItem('switchboard.autonomy') ?? 'ask'
  );
  const [preflightOk, setPreflightOk] = useState(true);
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [autoTrust, setAutoTrust] = useState(true);
  const grid = React.useRef<GridController | null>(null);

  useEffect(() => {
    void bridge.notifications?.getPrefs?.().then((p) => setNotifEnabled(p.enabled));
    void bridge.settings?.getAutoTrust?.().then(setAutoTrust);
    void bridge.preflight?.check?.().then((r) => {
      setPreflightOk(r.ok);
      setCliVersion(r.version);
    });
    // eslint's exhaustive-deps plugin isn't installed; bridge is stable
  }, []);

  const cycleAutonomy = (): void => {
    const order = ['ask', 'plan', 'auto-edit', 'full-auto'];
    const next = order[(order.indexOf(autonomy) + 1) % order.length];
    localStorage.setItem('switchboard.autonomy', next);
    setAutonomy(next);
  };

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
        folder: s.identity.folder,
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
        autonomy={autonomy}
        onCycleAutonomy={cycleAutonomy}
        autoTrust={autoTrust}
        onToggleTrust={() => {
          const next = !autoTrust;
          setAutoTrust(next);
          void bridge.settings?.setAutoTrust?.(next);
        }}
      />
      {!preflightOk && <PreflightBanner />}
      <div style={{ flex: 1, display: 'flex', minBlockSize: 0 }}>
        <SessionsRail
          sessions={sessions}
          onRename={(id, title) => {
            void bridge.sessions?.rename?.(id, title).then(() => refreshSessions());
          }}
          onFocus={(id) => grid.current?.focusSession(id)}
          onDiff={(s) => {
            if (s.folder) grid.current?.openDiff(s.id, s.folder, s.title);
          }}
        />
        <SessionGrid
          theme={theme}
          seedPanels={bridge.seedPanels ?? 0}
          onCardsChanged={setCards}
          controller={grid}
        />
        <FeedPanel sessions={sessions} onFocus={(id) => grid.current?.focusSession(id)} />
      </div>
      <StatusBar count={cards.length} theme={theme} cliVersion={cliVersion} />
    </div>
  );
}

function PreflightBanner(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      style={{
        background: 'var(--status-needs-permission)',
        color: 'var(--bar)',
        fontSize: 11,
        padding: '4px 12px',
      }}
    >
      {t('preflight.missingCli')}
    </div>
  );
}
