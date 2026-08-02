import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyPreference,
  applyTheme,
  followSystemTheme,
  loadPreference,
  resolveTheme,
  ThemeDefinition,
  ThemePreference,
} from './theme/theme';
import { listThemes } from './extensibility/themes';
import { LanguageChoice, loadLanguage, setLanguage } from './i18n';
import { TitleBar, StatusBar } from './components/chrome';
import { SessionsRail, RailGroup } from './components/SessionsRail';
import { SessionGrid, GridController } from './components/SessionGrid';
import { EventsPanel, EventDto } from './components/EventsPanel';
import { Usage, addUsage, estimateCostUsd, ZERO_USAGE } from './lib/usage';
import { loadUiState, uiGet, uiSet } from './lib/ui-state';
import { initPresentation } from './lib/presentation-boot';
import { boxOnAnyDisplay, RescuedPopout } from './lib/layout';
import { rendererRegistry } from './extensibility/registry-instance';
import { buildContributedCommands } from './extensibility/commands';
import { bindingFor, dispatch, formatBinding, Platform } from './lib/commands';
import { sessionStore } from './store/session-store';
import { CommandPalette } from './components/CommandPalette';
import { UrgencyStrip } from './components/UrgencyStrip';
import {
  applyTabRows,
  forgetPopoutWindow,
  loadTabRows,
  syncDocumentFlags,
  toggleTabRows,
  trackPopoutWindow,
} from './lib/tab-rows';

// One stable subscribe identity for every useSyncExternalStore call below.
// An inline arrow is a new function each render, and React unsubscribes and
// resubscribes whenever `subscribe` changes — six times per render, forever.
const subscribeStore = (cb: () => void): (() => void) => sessionStore.subscribe(cb);

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
  // Themes are contributions now (§5.20/§5.23): the registry is filled at the
  // entry point, before the first render, so resolving once here is safe — and
  // a memo rather than module scope, which would read an empty registry at
  // import time.
  const themes = React.useMemo(() => listThemes(rendererRegistry), []);
  const [pref, setPref] = useState<ThemePreference>(() => loadPreference(themes));
  // paint at boot, do NOT persist: writing back what we merely resolved would
  // overwrite a good preference the one time it failed to resolve
  const [theme, setTheme] = useState<ThemeDefinition>(() =>
    applyTheme(resolveTheme(loadPreference(themes), themes))
  );
  const [lang, setLang] = useState<LanguageChoice>(() => loadLanguage());
  // cards + the active card live in the store like everything else: it claims
  // to be the state authority, and a field it never receives would hand any
  // future reader an empty list forever
  const cards = useSyncExternalStore(subscribeStore, () => sessionStore.getState().cards);
  // which card the grid is showing — reflected as the rail's selected row
  const activeCard = useSyncExternalStore(
    subscribeStore,
    () => sessionStore.getState().activeCard
  );
  // sessions + groups live in the store: the rail renders from them, the
  // keyboard numbers from them, and one derivation means they cannot disagree
  const sessions = useSyncExternalStore(subscribeStore, () => sessionStore.getState().sessions);
  const groups = useSyncExternalStore(subscribeStore, () => sessionStore.getState().groups);
  const [palette, setPalette] = useState<string[]>([]);
  const [notifEnabled, setNotifEnabled] = useState(true);
  // gate the shell on the persisted UI state (E12-08): reads are sync after
  const [uiReady, setUiReady] = useState(false);
  const [autonomy, setAutonomy] = useState<string>('ask');
  // rail visibility (E9-01 'toggle rail' command) — persisted like the other
  // renderer prefs, read once the ui blob has loaded
  const [railHidden, setRailHidden] = useState(false);
  // command palette (E9-02) — deliberately NOT persisted: it opens on demand
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Attention events (E9-03). This subscription used to live inside
  // EventsPanel; it moved up here because the queue is the SINGLE ordering
  // authority — two independent subscriptions to events:changed could hand the
  // panel and the Ctrl+Space walk different lists, and then the highlighted
  // "next" row would not be where the hotkey actually takes you.
  // Events and the walk cursor live in the STORE (P2-E15-07). They used to be
  // state plus a shadowing ref, because a keydown arriving before React
  // re-rendered had to see the session that just called. The store's
  // getState() is synchronous, so the requirement is met by the state layer
  // rather than by every component remembering to keep a ref in sync.
  const events = useSyncExternalStore(subscribeStore, () => sessionStore.getState().events);
  const visited = useSyncExternalStore(subscribeStore, () => sessionStore.getState().visited);
  // The urgency strip (E9-04). It renders from RAIL ORDER, not the raw session
  // list, so the Nth lamp is the Nth Ctrl+1..9 target — the derived value has a
  // stable identity (recomputed only when sessions/groups change), which is
  // what useSyncExternalStore requires.
  const railFlat = useSyncExternalStore(subscribeStore, () => sessionStore.getRailOrder().flat);
  const urgency = useSyncExternalStore(subscribeStore, () => sessionStore.getState().urgency);
  const expireUrgency = React.useCallback(() => sessionStore.expireUrgency(), []);
  useEffect(() => {
    void loadUiState().then(() => {
      // before anything can write presentation state, and before the grid
      // mounts (uiReady gates it): an early write would persist an empty map
      // over the saved one (P2-E15-08)
      initPresentation();
      setAutonomy(uiGet('autonomy', 'ask'));
      setRailHidden(uiGet('railHidden', false));
      applyTabRows(loadTabRows()); // multi-row tab strip, default on (#84)
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

  // eslint-disable-next-line no-restricted-syntax -- returns its unsubscribe
  useEffect(() => followSystemTheme(themes, setTheme), [themes]);

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
    sessionStore.setSessions(
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
    if (list) sessionStore.setGroups(list as RailGroup[]);
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
    return sessionStore.subscribeMembership(h);
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

  // ── attention queue (E9-03, §5.8) ────────────────────────────────────────
  useEffect(() => {
    // a push landing while list() is in flight must not be overwritten by the
    // stale snapshot (review P1 #15) — pushes always win
    let gotPush = false;
    const off = window.switchboard?.events?.onChanged?.((l) => {
      gotPush = true;
      sessionStore.setEvents(l as EventDto[]);
    });
    void window.switchboard?.events?.list?.().then((l) => {
      if (!gotPush) sessionStore.setEvents(l as EventDto[]);
    });
    return off;
  }, []);

  // ── keyboard commands (E9-01) ────────────────────────────────────────────
  // One document-level listener owns every binding; lib/commands decides
  // whether a key is ours to take (never in a text input, NEVER in a terminal).
  // Rail order is the numbering authority for Ctrl+1..9 — the same function the
  // rail renders from (collapsed groups included: collapsing hides rows, it
  // doesn't renumber the workspace).
  // the store derives rail order from the same sessions+groups the rail
  // renders, so Ctrl+1..9 numbering and the eye can never disagree
  const railHiddenRef = React.useRef(railHidden);
  // read by the dispatcher: an open modal swallows the app's accelerators
  const paletteOpenRef = React.useRef(paletteOpen);
  useEffect(() => {
    railHiddenRef.current = railHidden;
    paletteOpenRef.current = paletteOpen;
  });

  // Set when a command deliberately raised a DIFFERENT OS window (jumping to a
  // popped-out session). The popout key bridge below reads it: without it,
  // focusing a popout and then pulling the main window forward would bury the
  // very session you asked for.
  const raisedOtherWindowRef = React.useRef(false);
  const focusSession = React.useCallback((sessionId: string): boolean => {
    const raised = grid.current?.focusSession(sessionId) ?? false;
    if (raised) raisedOtherWindowRef.current = true;
    return raised;
  }, []);


  const jumpToNextAttention = React.useCallback(() => {
    // synchronous read AND write: two presses in one frame advance two steps
    const next = sessionStore.advanceQueue();
    if (!next) return; // empty queue: a no-op, never a focus change
    // focusSession maps a live session id to its card itself, and passes any
    // id it doesn't recognise straight through
    focusSession(next.sessionId);
    // §5.8's delayed urgency reset: keep the arrived-at lamp lit for a beat so
    // you can still see WHICH session called you. Keyed by CARD id — the event
    // carries the live id, which churns on every resume, and a lamp that went
    // dark because the session respawned would defeat the whole point.
    sessionStore.markUrgency(sessionStore.cardIdForLive(next.sessionId));
    // "Done." relaxes to "Ready" — you have now looked at it. Every other kind
    // is untouched by ack and leaves the queue only when actually answered,
    // which is exactly why the visited set above has to exist.
    void window.switchboard?.events?.ack?.(next.sessionId);
  }, [focusSession]);
  // a theme switch must reach the popped-out windows too — they're separate
  // documents that don't inherit our <html> flags (#84)
  useEffect(() => {
    syncDocumentFlags();
  }, [theme.id]);
  const platform: Platform = bridge.platform === 'darwin' ? 'darwin' : 'other';
  const toggleRail = React.useCallback(() => {
    const next = !railHiddenRef.current;
    railHiddenRef.current = next;
    uiSet('railHidden', next);
    setRailHidden(next);
  }, []);
  // Contributed commands, not imported ones (§5.23): App knows the app's
  // callbacks, the registry knows who wants them. Adding a command set means
  // registering it in bootstrap.ts — no edit here.
  const commands = React.useMemo(
    () =>
      buildContributedCommands(rendererRegistry, {
          focusCard: (cardId) => focusSession(cardId),
          newSession: () => {
            void bridge.sessions?.pickFolder?.().then((folder) => {
              if (folder) void grid.current?.addSessionCard(folder);
            });
          },
          closeCard: (cardId) => grid.current?.closeCard(cardId),
          toggleCardView: (cardId, view) => grid.current?.toggleCardView(cardId, view),
          popOutCard: (cardId) => grid.current?.popOutCard(cardId),
          hideCard: (cardId) => grid.current?.hideCard(cardId),
          toggleRail,
          openPalette: () => setPaletteOpen(true),
          toggleTabRows: () => {
            toggleTabRows();
          },
          jumpToNextAttention,
      }),
    [toggleRail, jumpToNextAttention], // other deps read live state through refs; grid.current is stable
  );
  // chips advertise their own binding, derived from the registry so a tooltip
  // can never drift from the key that actually works
  const railBindingLabel = formatBinding(bindingFor(commands, 'view.rail'), platform);
  const paletteBindingLabel = formatBinding(bindingFor(commands, 'palette.open'), platform);
  const queueBindingLabel = formatBinding(bindingFor(commands, 'attention.next'), platform);
  // the palette reads the SAME context the dispatcher does, at open time
  // ONE builder for both readers (the palette at open time, the dispatcher at
  // keypress time). They used to construct this separately, which is how a
  // command ends up enabled in the palette and dead on the keyboard.
  const commandContext = React.useCallback(
    () => ({
      // read from the store, not a ref: this runs on KEYDOWN, outside React's
      // commit, so it has to see what is true now
      sessions: sessionStore.getRailOrder().flat,
      activeCardId: grid.current?.activeCardId() ?? null,
      attentionCount: sessionStore.getQueue().length,
    }),
    [],
  );
  const focusCard = React.useCallback((cardId: string) => focusSession(cardId), [focusSession]);
  const popoutKeysRef = React.useRef(new Map<Window, (e: KeyboardEvent) => void>());
  useEffect(() => {
    // Returns the command that ran (or null) — the popout bridge below needs
    // the REAL answer, not a guess from e.defaultPrevented: the composer
    // preventDefaults its own Enter, and mistaking that for a command would
    // yank this window in front of the one being typed in.
    const onKey = (e: KeyboardEvent): unknown => {
      // while the palette owns the screen, nothing underneath it fires —
      // regardless of where focus ended up inside the modal
      if (paletteOpenRef.current) return null;
      return dispatch(
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
        commandContext(),
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

    // Popped-out sessions live in their own OS windows, but their JS runs here
    // (dockview adopts the DOM). Without this they'd be deaf to every shortcut
    // — and the palette's whole promise is that capability is never out of
    // reach (§5.8). Most of what the commands touch is in THIS window, so a
    // command that actually RUNS brings this window forward with it; an
    // ordinary keystroke in the popout never does.
    //
    // The exception is a command that jumped to ANOTHER popped-out session:
    // it already raised that window, and pulling the main window forward
    // afterwards would bury the session the user just asked for. The attention
    // jump makes this routine — the queue targets whatever is blocked, and
    // blocked sessions are exactly the ones people pop out.
    //
    // The window→handler map lives in a ref, not this closure: if the effect
    // ever re-runs (a new dep), popouts opened earlier must be re-attached,
    // not silently deafened.
    const popoutKeys = popoutKeysRef.current;
    const attach = (win: Window): void => {
      if (popoutKeys.has(win)) return;
      const handler = (e: KeyboardEvent): void => {
        raisedOtherWindowRef.current = false;
        if (onKey(e) && !raisedOtherWindowRef.current) window.focus();
      };
      popoutKeys.set(win, handler);
      win.addEventListener('keydown', handler);
    };
    const detach = (win: Window): void => {
      const handler = popoutKeys.get(win);
      if (!handler) return;
      win.removeEventListener('keydown', handler);
      popoutKeys.delete(win);
    };
    // re-attach anything opened before this (re-)run
    for (const win of [...popoutKeys.keys()]) {
      detach(win);
      attach(win);
    }
    const onAdded = (e: Event): void => {
      const win = (e as CustomEvent<Window>).detail;
      attach(win);
      // a popout is its own document: give it our theme + tab-row flags (#84)
      trackPopoutWindow(win);
    };
    const onRemoved = (e: Event): void => {
      const win = (e as CustomEvent<Window>).detail;
      detach(win);
      forgetPopoutWindow(win);
    };
    window.addEventListener('switchboard:popout-added', onAdded);
    window.addEventListener('switchboard:popout-removed', onRemoved);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('switchboard:popout-added', onAdded);
      window.removeEventListener('switchboard:popout-removed', onRemoved);
      // detach the LISTENERS but keep the window keys: a re-run re-attaches
      // them above with fresh handlers. (A popout closed during app teardown
      // may not fire its remove event — a dead Window in the map is inert.)
      for (const [win, handler] of popoutKeys) win.removeEventListener('keydown', handler);
    };
  }, [commands, platform, commandContext]);

  if (!uiReady) return <div style={{ blockSize: '100vh' }} />; // one-frame gate while UI state loads

  return (
    <div style={{ blockSize: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TitleBar
        version={bridge.appVersion}
        pref={pref}
        themes={themes}
        onTheme={(p) => {
          setPref(p);
          setTheme(applyPreference(p, themes));
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
        onOpenPalette={() => setPaletteOpen(true)}
        paletteBinding={paletteBindingLabel}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        contextOf={commandContext}
        focusCard={focusCard}
        platform={platform}
      />
      {!preflightOk && <PreflightBanner />}
      {/* Outside the rail (which toggles) and outside the grid (whose cards
          hide, pop out and — with E9-07 — rearrange by layout mode): the only
          place a strip can be "always visible" without every one of those
          surfaces remembering to draw it. §5.8. */}
      <UrgencyStrip
        sessions={railFlat}
        urgency={urgency}
        activeCardId={activeCard}
        onFocus={focusCard}
        onExpire={expireUrgency}
      />
      <div style={{ flex: 1, display: 'flex', minBlockSize: 0 }}>
        {!railHidden && (
          <SessionsRail
            sessions={sessions}
            groups={groups}
            palette={palette}
            onRename={(cardId, title) => {
              void bridge.sessions?.renameCard?.(cardId, title).then(() => refreshSessions());
            }}
            onFocus={(cardId) => focusSession(cardId)}
            onDiff={(s) => {
              if (s.folder) grid.current?.openDiff(s.id, s.folder, s.title);
            }}
            onClose={(cardId) => grid.current?.closeCard(cardId)}
            selectedId={activeCard}
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
          colorScheme={theme.colorScheme}
          seedPanels={bridge.seedPanels ?? 0}
          onCardsChanged={(c) => sessionStore.setCards(c)}
          onActiveCardChanged={(c) => sessionStore.setActiveCard(c)}
          controller={grid}
        />
        <EventsPanel
          sessions={sessions}
          events={events}
          visited={visited}
          queueBinding={queueBindingLabel}
          onFocus={(id) => focusSession(id)}
          onVisit={(eventId) => sessionStore.visit(eventId)}
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
