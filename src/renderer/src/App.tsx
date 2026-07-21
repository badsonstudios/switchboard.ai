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
import { Usage, addUsage, estimateCostUsd, ZERO_USAGE } from './lib/usage';

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
  const [usageByLive, setUsageByLive] = useState<Map<string, { usage: Usage; model?: string }>>(
    new Map()
  );
  const grid = React.useRef<GridController | null>(null);

  useEffect(() => {
    return bridge.sessions?.onUsage?.((snap) => {
      const s = snap as { sessionId: string; usage: Usage; model?: string };
      setUsageByLive((prev) => new Map(prev).set(s.sessionId, { usage: s.usage, model: s.model }));
    });
    // eslint's exhaustive-deps plugin isn't installed; bridge is stable
  }, []);

  const workspaceUsage = [...usageByLive.values()].reduce(
    (acc, v) => addUsage(acc, v.usage),
    ZERO_USAGE
  );
  const workspaceCost = [...usageByLive.values()].reduce(
    (acc, v) => acc + estimateCostUsd(v.usage, v.model),
    0
  );

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
    // card-keyed view: includes SUSPENDED cards (restored, not yet resumed)
    const list = await bridge.sessions?.cards?.();
    if (!list) return;
    setSessions(
      list.map((c) => ({
        id: c.cardId,
        title: c.title,
        folder: c.folder,
        accent: c.accent,
        badge: c.badge,
        status: c.status,
      }))
    );
  }, []); // bridge is stable for the window's lifetime

  useEffect(() => {
    void refreshSessions();
    const offStatus = bridge.sessions?.onStatus?.(() => void refreshSessions());
    const offExit = bridge.sessions?.onExited?.(() => void refreshSessions());
    return () => {
      offStatus?.();
      offExit?.();
    };
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
          onRename={(cardId, title) => {
            void bridge.sessions?.renameCard?.(cardId, title).then(() => refreshSessions());
          }}
          onFocus={(cardId) => grid.current?.focusSession(cardId)}
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
      <StatusBar
        count={cards.length}
        theme={theme}
        cliVersion={cliVersion}
        totalOutputTokens={workspaceUsage.output}
        totalCostUsd={workspaceCost}
      />
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
