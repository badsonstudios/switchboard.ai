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
import { TitleBar, SessionsRail, StatusBar, RailSession, RailGroup } from './components/chrome';
import { SessionGrid, GridController } from './components/SessionGrid';
import { EventsPanel } from './components/EventsPanel';
import { Usage, addUsage, estimateCostUsd, ZERO_USAGE } from './lib/usage';
import { loadUiState, uiGet, uiSet } from './lib/ui-state';
import { boxOnAnyDisplay, RescuedPopout } from './lib/layout';
import { railOrder } from './lib/groups';
import { buildCommands } from './lib/command-set';
import { bindingFor, dispatch, formatBinding, Platform } from './lib/commands';

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
  const [groups, setGroups] = useState<RailGroup[]>([]);
  const [palette, setPalette] = useState<string[]>([]);
  const [notifEnabled, setNotifEnabled] = useState(true);
  // gate the shell on the persisted UI state (E12-08): reads are sync after
  const [uiReady, setUiReady] = useState(false);
  const [autonomy, setAutonomy] = useState<string>('ask');
  // rail visibility (E9-01 'toggle rail' command) — persisted like the other
  // renderer prefs, read once the ui blob has loaded
  const [railHidden, setRailHidden] = useState(false);
  useEffect(() => {
    void loadUiState().then(() => {
      setAutonomy(uiGet('autonomy', 'ask'));
      setRailHidden(uiGet('railHidden', false));
      setUiReady(true);
    });
  }, []);
  const [preflightOk, setPreflightOk] = useState(true);
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [autoTrust, setAutoTrust] = useState(true);
  const [usageByLive, setUsageByLive] = useState<Map<string, { usage: Usage; model?: string }>>(
    new Map()
  );
  const grid = React.useRef<GridController | null>(null);

  useEffect(() => {
    const offUsage = bridge.sessions?.onUsage?.((snap) => {
      const s = snap as { sessionId: string; usage: Usage; model?: string };
      setUsageByLive((prev) => new Map(prev).set(s.sessionId, { usage: s.usage, model: s.model }));
    });
    // prune a dead live id so the workspace total doesn't double-count after a
    // resume (the resumed session re-reads the full conversation) or a close
    const offExit = bridge.sessions?.onExited?.((e) => {
      const x = e as { sessionId: string };
      setUsageByLive((prev) => {
        if (!prev.has(x.sessionId)) return prev;
        const next = new Map(prev);
        next.delete(x.sessionId);
        return next;
      });
    });
    return () => {
      offUsage?.();
      offExit?.();
    };
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
    uiSet('autonomy', next);
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
        groupId: c.groupId,
        autoKey: c.autoKey,
        liveId: c.liveId,
        taskLabel: c.taskLabel,
      }))
    );
  }, []); // bridge is stable for the window's lifetime

  const refreshGroups = React.useCallback(async () => {
    const list = await bridge.groups?.list?.();
    if (list) setGroups(list as RailGroup[]);
  }, []); // bridge is stable

  useEffect(() => {
    void refreshGroups();
    void bridge.groups?.palette?.().then(setPalette);
  }, [refreshGroups]);

  // display reconnected: OFFER to restore rescued popouts — never automatic
  // (the new display might be a projector, E8-06/§7)
  const [reconnectOffer, setReconnectOffer] = useState(false);
  useEffect(() => {
    const off = bridge.onDisplaysChanged?.((areas) => {
      const stash = uiGet<RescuedPopout[]>('rescuedPopouts', []);
      if (stash.some((r) => boxOnAnyDisplay(r.box, areas))) setReconnectOffer(true);
    });
    return () => off?.();
  }, []);

  // grid drags change membership in the main process (E12-04) — re-read
  useEffect(() => {
    const h = (): void => {
      void refreshSessions();
      void refreshGroups();
    };
    window.addEventListener('switchboard:groups-changed', h);
    return () => window.removeEventListener('switchboard:groups-changed', h);
  }, [refreshSessions, refreshGroups]);

  useEffect(() => {
    void refreshSessions();
    const offStatus = bridge.sessions?.onStatus?.(() => void refreshSessions());
    const offExit = bridge.sessions?.onExited?.(() => void refreshSessions());
    return () => {
      offStatus?.();
      offExit?.();
    };
  }, [cards, refreshSessions]); // re-sync when the grid's cards change

  // ── keyboard commands (E9-01) ────────────────────────────────────────────
  // One document-level listener owns every binding; lib/commands decides
  // whether a key is ours to take (never in a text input, NEVER in a terminal).
  // Rail order is the numbering authority for Ctrl+1..9 — the same function the
  // rail renders from (collapsed groups included: collapsing hides rows, it
  // doesn't renumber the workspace).
  const railSessions = railOrder(sessions, groups).flat;
  const railSessionsRef = React.useRef(railSessions);
  const railHiddenRef = React.useRef(railHidden);
  // refs are written AFTER commit, never during render: the keydown handler
  // only ever runs post-commit, so this is fresh enough and stays correct if
  // React ever abandons a render
  useEffect(() => {
    railSessionsRef.current = railSessions;
    railHiddenRef.current = railHidden;
  });
  const platform: Platform = bridge.platform === 'darwin' ? 'darwin' : 'other';
  const toggleRail = React.useCallback(() => {
    const next = !railHiddenRef.current;
    railHiddenRef.current = next;
    uiSet('railHidden', next);
    setRailHidden(next);
  }, []);
  const commands = React.useMemo(
    () =>
      buildCommands({
        focusCard: (cardId) => grid.current?.focusSession(cardId),
        newSession: () => {
          void bridge.sessions?.pickFolder?.().then((folder) => {
            if (folder) void grid.current?.addSessionCard(folder);
          });
        },
        closeCard: (cardId) => grid.current?.closeCard(cardId),
        toggleCardView: (cardId, view) => grid.current?.toggleCardView(cardId, view),
        popOutCard: (cardId) => grid.current?.popOutCard(cardId),
        toggleRail,
      }),
    [toggleRail], // other deps read live state through refs; grid.current is stable
  );
  // the rail chip advertises its own binding, derived from the registry so the
  // tooltip can never drift from the key that actually works
  const railBindingLabel = formatBinding(bindingFor(commands, 'view.rail'), platform);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      dispatch(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          code: e.code,
          isComposing: e.isComposing,
          repeat: e.repeat,
          target: e.target as Element | null,
          preventDefault: () => e.preventDefault(),
        },
        commands,
        {
          sessions: railSessionsRef.current,
          activeCardId: grid.current?.activeCardId() ?? null,
        },
        platform,
        // fail-open: a broken command logs and is forgotten, never an uncaught
        // error in the keydown handler (the main process tails this console)
        (err, id) => console.error(`[commands] ${id} failed`, err),
      );
    };
    // Bubble phase, so a component that stops propagation keeps its keys. The
    // real protection for text inputs is classifyTarget in lib/commands — the
    // composer only calls preventDefault, it never stops propagation.
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commands, platform]);

  if (!uiReady) return <div style={{ blockSize: '100vh' }} />; // one-frame gate while UI state loads

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
        railHidden={railHidden}
        onToggleRail={toggleRail}
        railBinding={railBindingLabel}
      />
      {!preflightOk && <PreflightBanner />}
      <div style={{ flex: 1, display: 'flex', minBlockSize: 0 }}>
        {!railHidden && (
          <SessionsRail
            sessions={sessions}
            groups={groups}
            palette={palette}
            onRename={(cardId, title) => {
              void bridge.sessions?.renameCard?.(cardId, title).then(() => refreshSessions());
            }}
            onFocus={(cardId) => grid.current?.focusSession(cardId)}
            onDiff={(s) => {
              if (s.folder) grid.current?.openDiff(s.id, s.folder, s.title);
            }}
            onCreateGroup={(name) => {
              void bridge.groups?.create?.({ name }).then(() => refreshGroups());
            }}
            onRenameGroup={(id, name) => {
              void bridge.groups?.update?.(id, { name }).then(() => refreshGroups());
            }}
            onRecolorGroup={(id, color) => {
              void bridge.groups?.update?.(id, { color }).then(() => refreshGroups());
            }}
            onMoveToGroup={(cardId, gid) => {
              void bridge.groups?.setSessionGroup?.(cardId, gid).then(() => {
                grid.current?.moveCardToGroup(cardId, gid);
                void refreshSessions();
              });
            }}
            onOpenInGroup={(gid) => {
              void bridge.sessions?.pickFolder?.().then((folder) => {
                if (folder) void grid.current?.addSessionCard(folder, gid);
              });
            }}
            onDeleteGroup={(id) => {
              // members fall back to ungrouped, so the session list changes too
              void bridge.groups?.remove?.(id).then(() => {
                void refreshGroups();
                void refreshSessions();
              });
            }}
          />
        )}
        <SessionGrid
          theme={theme}
          seedPanels={bridge.seedPanels ?? 0}
          onCardsChanged={setCards}
          controller={grid}
        />
        <EventsPanel
          sessions={sessions}
          onFocus={(id) => grid.current?.focusSession(id)}
          reconnectOffer={reconnectOffer}
          onRestoreLayout={() => {
            grid.current?.restoreRescuedPopouts();
            setReconnectOffer(false);
          }}
          onDismissOffer={() => setReconnectOffer(false)}
        />
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
