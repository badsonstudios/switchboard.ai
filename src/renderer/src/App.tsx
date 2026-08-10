import React, { useEffect, useState, useSyncExternalStore } from 'react';
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
import { bindingFor, dispatch, dispatchAccelerator, formatBinding, Platform } from './lib/commands';
import { focusedElementIn } from './lib/focus-target';
import { sessionStore } from './store/session-store';
import { CommandPalette } from './components/CommandPalette';
import { AboutPanel } from './components/AboutPanel';
import { UpdateDialog } from './components/UpdateDialog';
import type { UpdateInstallStatus, UpdateStatus } from '../../shared/update';
import { UrgencyStrip } from './components/UrgencyStrip';
import { CollapsedStrip } from './components/CollapsedStrip';
import { BatchApprovalBar } from './components/BatchApprovalBar';
import { memberViews } from './lib/permission-batches';
import type { PermissionRequestDto } from '../../shared/ipc/permissions';
import { WorkspaceNoticeBanner } from './components/WorkspaceNoticeBanner';
import { PreflightBanner } from './components/PreflightBanner';
import { collapsedRows, revealTargets } from './lib/ladder';
import { GuardedRefresh, latestWins } from './lib/latest-wins';
import { groupChangeLanded } from './lib/groups';
import {
  cycleGlobal,
  cycleOverride,
  groupOverride,
  PresentationPolicy,
  withCard,
  withGlobal,
  withGroup,
} from './lib/presentation-policy';
import {
  attentionResponse,
  FocusPolicy,
  withFocusCard,
  withFocusGlobal,
} from './lib/focus-policy';
import { buildIdentity } from '../../shared/build-identity';
import { applyTabRows, loadTabRows, syncDocumentFlags, toggleTabRows } from './lib/tab-rows';
import { openPopoutWindows, subscribePopoutWindows } from './lib/popout-windows';

// One stable subscribe identity for every useSyncExternalStore call below.
// An inline arrow is a new function each render, and React unsubscribes and
// resubscribes whenever `subscribe` changes — six times per render, forever.
const subscribeStore = (cb: () => void): (() => void) => sessionStore.subscribe(cb);

// Compiled in at build time and constant for the process lifetime (E15-15), so
// it is read once at module scope rather than per render.
const BUILD_IDENTITY = buildIdentity();

/** Install phases that still have something happening (E19-04). */
const LIVE_INSTALL: ReadonlySet<UpdateInstallStatus['phase']> = new Set([
  'downloading',
  'verifying',
  'launching',
]);

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
  // About / build identity (E15-15) — same deal, on demand only
  const [aboutOpen, setAboutOpen] = useState(false);
  // ── update checks (E19-03) ───────────────────────────────────────────────
  // The dialog is driven by a STATUS, not by a boolean: main decides whether
  // there is anything to show (`prompt`) because only main knows which version
  // was skipped, and the renderer's job is to obey that decision.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  // ── the install (E19-04) ─────────────────────────────────────────────────
  // Progress lives here rather than in the dialog because it OUTLIVES the
  // dialog: a cancelled download leaves the offer standing in the events
  // panel, and the panel is App's to render.
  const [installStatus, setInstallStatus] = useState<UpdateInstallStatus | null>(null);
  // The one-shot "you're now on vX" the previous run earned, and the "still on
  // offer" nudge. Both render in the events panel; both are dismissible and
  // neither survives a relaunch (the handshake is consumed by main on read).
  const [updateNotice, setUpdateNotice] = useState<{
    kind: 'installed' | 'available';
    version: string;
  } | null>(null);
  // "Ignore" means NOT THIS RUN, and that is all it means — nothing is
  // persisted, so a relaunch offers the release again. It lives in a ref
  // rather than the store because it is deliberately not durable: "Skip this
  // version" is the durable answer, and conflating the two would leave a user
  // who clicked the soft option unable to find the release again.
  const ignoredVersion = React.useRef<string | null>(null);
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
  // The same list minus the sessions silenced by E9-10's `none` — what the
  // panel's next-up highlight has to be computed from, or it would point at a
  // row Ctrl+Space will skip. The panel still LISTS them: the feed is the log.
  const attentionFeed = useSyncExternalStore(subscribeStore, () =>
    sessionStore.getAttentionEvents()
  );
  // The urgency strip (E9-04). It renders from RAIL ORDER, not the raw session
  // list, so the Nth lamp is the Nth Ctrl+1..9 target — the derived value has a
  // stable identity (recomputed only when sessions/groups change), which is
  // what useSyncExternalStore requires.
  const railFlat = useSyncExternalStore(subscribeStore, () => sessionStore.getRailOrder().flat);
  const urgency = useSyncExternalStore(subscribeStore, () => sessionStore.getState().urgency);
  const expireUrgency = React.useCallback(() => sessionStore.expireUrgency(), []);
  // §5.8's ladder (E9-05). The strip renders from rail order for the reason the
  // lamps do — a session must not be third in one list and first in another.
  const presentation = useSyncExternalStore(
    subscribeStore,
    () => sessionStore.getState().presentation
  );
  // §5.8's pinning contract (E9-09). From the store for the reason the ladder
  // and the policy are: the rail RENDERS from it, rail order is DERIVED from it,
  // and the submit sweep + close-all read it synchronously outside React's
  // commit.
  const pinned = useSyncExternalStore(subscribeStore, () => sessionStore.getPins());
  const togglePin = React.useCallback((cardId: string) => sessionStore.togglePin(cardId), []);
  const collapsed = React.useMemo(
    () =>
      collapsedRows(
        railFlat,
        (id) => presentation.get(id)?.ladder ?? 'expanded',
        (id) => pinned.has(id)
      ),
    [railFlat, presentation, pinned]
  );
  // §5.8's batch permission prompt (P2-E9-11). The store keeps the whole-fleet
  // ledger of held requests and derives the ONE group on screen; App owns the
  // subscription that fills it, because it is the only component that is always
  // mounted — a card is not (dockview mounts what it shows), and the sibling
  // session asking the same question is usually behind a card that is not.
  const permissionBatch = useSyncExternalStore(subscribeStore, () =>
    sessionStore.getPermissionBatch()
  );
  const batchMembers = React.useMemo(
    () => (permissionBatch ? memberViews(permissionBatch, sessions) : []),
    [permissionBatch, sessions]
  );
  const decideBatch = React.useCallback(
    (requestIds: readonly string[], decision: 'allow' | 'deny') => {
      // One call PER REQUEST, on the same channel the card's own bar uses
      // (E10-04) — there is no batch verb in main and there must not be: each
      // held request is a separate CLI blocked on a separate answer, and main
      // routing them one by one is what keeps a partly-failed batch honest.
      // Deliberately NOT `allowAllSession`: see BatchApprovalBar's header.
      for (const requestId of requestIds) {
        void bridge.sessions
          ?.decidePermission?.(requestId, decision)
          // FALSE means main never had it — released, timed out, or resolved by
          // something else, and no `permissionResolved` is coming for it. Self-
          // heal, or the ledger would count a phantom session on the card for
          // the rest of the run.
          .then((owned) => {
            if (!owned) sessionStore.removePendingPermission(requestId);
          })
          // A REJECTION is not the same answer. `sessions:decidePermission`
          // resolves false rather than throwing, so this is the channel itself
          // failing — main gone, handler unregistered mid-teardown — and in
          // that state we know nothing about whether the request is still held.
          // Leaving it in the ledger keeps it on screen; dropping it would take
          // a live question off every surface on a guess.
          .catch(() => {});
      }
      // Note what is NOT here: an optimistic drop from the ledger.
      //
      // The per-card bar pops its queue on click, and has to — it is the only
      // thing holding the request. This card is not: main is, and main's
      // `permissionResolved` reaches the shell and every card in one push, so
      // letting it do the clearing keeps the grouped card and the cards'
      // own bars in step. Dropping optimistically here would take the group
      // down a whole IPC round trip before the cards heard, and for that round
      // trip a mounted card would draw its own review bar over a question that
      // was answered before the user let go of the mouse.
      //
      // The cost is that these buttons stay live until the answers land. That
      // is safe: `sessions:decidePermission` is keyed by request id, and a
      // second verdict for a request main has already released is refused,
      // which is exactly the branch above.
    },
    [bridge]
  );
  // The one subscription behind the ledger. Deliberately the same three
  // primitives the cards use — a live push, a resolution, and the replay for
  // whatever arrived before we subscribed (E10-04 review P0#3: a missed push
  // must never park the CLI) — plus the store's own live-retired signal, so a
  // dead session's question leaves the group the moment the renderer knows,
  // without waiting on main's best-effort release (#239).
  useEffect(() => {
    // An allow-all session is answered without a bar, at the server for PTY and
    // by the card for stream. Its requests must never reach a group, or a
    // session the user took out of the loop would flash into a prompt and be
    // counted in "2 sessions want…".
    const groupable = (r: PermissionRequestDto): boolean => !sessionStore.isAllowAll(r.sessionId);
    const take = (r: PermissionRequestDto): void => {
      if (groupable(r)) sessionStore.addPendingPermission(r);
    };
    const offReq = bridge.sessions?.onPermissionRequest?.(take);
    const offRes = bridge.sessions?.onPermissionResolved?.((r) =>
      sessionStore.removePendingPermission(r.requestId)
    );
    const offRetired = sessionStore.subscribeLiveRetired((liveId) =>
      sessionStore.dropPendingPermissionsForLive(liveId)
    );
    void bridge.sessions
      ?.pendingPermissions?.()
      // one write for the whole replay, not one per request
      .then((list) => sessionStore.addPendingPermissions(list.filter(groupable)))
      // fail-open: a ledger that never fills costs the grouped card, not a
      // session — every one of these requests is still on its own card's bar
      .catch(() => {});
    return () => {
      offReq?.();
      offRes?.();
      offRetired();
    };
    // bridge is resolved once per mount and stable for the process
  }, []);
  // §5.8's presentation policy (E9-06). Read from the store rather than App
  // state, because the SUBMIT path reads it synchronously from outside React's
  // commit — the same requirement that put the ladder there.
  const policies = useSyncExternalStore(subscribeStore, () => sessionStore.getPolicies());
  const setGlobalPolicy = React.useCallback(
    (p: PresentationPolicy) => sessionStore.setPolicies(withGlobal(sessionStore.getPolicies(), p)),
    []
  );
  const setSessionPolicy = React.useCallback(
    (cardId: string, p: PresentationPolicy | undefined) =>
      sessionStore.setPolicies(withCard(sessionStore.getPolicies(), cardId, p)),
    []
  );
  const setGroupPolicy = React.useCallback(
    (groupId: string, p: PresentationPolicy | undefined) =>
      sessionStore.setPolicies(withGroup(sessionStore.getPolicies(), groupId, p)),
    []
  );
  // The two CYCLES read-then-write on the store's own snapshot, never on the
  // rendered `policies` — a click handler must act on what is true now, not on
  // the last commit.
  const cycleGlobalPolicy = React.useCallback(
    () => setGlobalPolicy(cycleGlobal(sessionStore.getPolicies().global)),
    [setGlobalPolicy]
  );
  const cycleGroupPolicy = React.useCallback(
    (groupId: string) =>
      setGroupPolicy(groupId, cycleOverride(groupOverride(sessionStore.getPolicies(), groupId))),
    [setGroupPolicy]
  );
  // §5.8's focus-stealing policy (E9-10). Read from the store for the reason
  // the presentation policy is: the reveal effect below resolves it per event,
  // and the rail menu renders the tick from the same book.
  const focusPolicies = useSyncExternalStore(subscribeStore, () =>
    sessionStore.getFocusPolicies()
  );
  const setGlobalFocusPolicy = React.useCallback(
    (p: FocusPolicy) =>
      sessionStore.setFocusPolicies(withFocusGlobal(sessionStore.getFocusPolicies(), p)),
    []
  );
  const setSessionFocusPolicy = React.useCallback(
    (cardId: string, p: FocusPolicy | undefined) =>
      sessionStore.setFocusPolicies(withFocusCard(sessionStore.getFocusPolicies(), cardId, p)),
    []
  );
  // §5.8's layout mode (E9-07). In the store for the reason the ladder and the
  // policy are: the chip renders from it AND the sweep reads it synchronously
  // from a keydown handler, outside React's commit.
  const layout = useSyncExternalStore(subscribeStore, () => sessionStore.getState().layout);
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

  // ── update checks (E19-03, §E19) ─────────────────────────────────────────
  //
  // Every route into the dialog lands here: the startup check below, the daily
  // timer's push, the Help menu's push, and the three manual buttons. One
  // decision function, so "when does this appear" has a single answer.
  const applyUpdateStatus = React.useCallback((s: UpdateStatus | null | undefined) => {
    if (!s?.result) return;
    setUpdateStatus(s);
    // A fresh answer retires the last install's OUTCOME — the failure message
    // from ten minutes ago must not be what the dialog opens showing. But not a
    // live one: the daily timer keeps ticking during a download, and clearing
    // here would swap the progress bar for the offer while the transfer is
    // still running.
    setInstallStatus((prev) => (prev && LIVE_INSTALL.has(prev.phase) ? prev : null));
    // A manual check always shows something — up to date and "couldn't check"
    // included. An automatic one shows the dialog only when main says prompt,
    // and not for a version dismissed with Ignore this run.
    if (s.manual) return void setUpdateOpen(true);
    if (!s.prompt) return;
    if (s.result.latestVersion && s.result.latestVersion === ignoredVersion.current) return;
    setUpdateOpen(true);
  }, []);

  useEffect(() => {
    // The pushes: a check nobody in this window asked for (the daily timer, or
    // the menu item, which has no return path to a caller).
    const off = bridge.update?.onStatus?.((s) => applyUpdateStatus(s));
    // Progress for a download this window started (E19-04). Subscribed here
    // rather than around the call so a status that lands while the dialog is
    // being re-rendered is not dropped.
    const offInstall = bridge.update?.onInstallStatus?.((s) => setInstallStatus(s));
    // THE HANDSHAKE. Main resolved it before the first window existed and is
    // holding the answer; this is the only thing that ever asks for it.
    void bridge.update
      ?.handshake?.()
      .then((h) => h?.updatedTo && setUpdateNotice({ kind: 'installed', version: h.updatedTo }))
      .catch(() => {});
    void bridge.update
      ?.getPrefs?.()
      .then((p) => setAutoCheckUpdates(p.autoCheck !== false))
      .catch(() => {});
    // THE STARTUP CHECK. Driven from here rather than from main's bootstrap
    // for one reason: this is the first moment a window provably exists to
    // receive the answer. A check fired at boot would race the window it wants
    // to talk to and lose that race silently on a slow machine. Main
    // coalesces repeats, so a second mount costs no second API call.
    void bridge.update
      ?.check?.({ manual: false })
      .then((s) => applyUpdateStatus(s))
      // fail-open, and this is the load-bearing one: a rejected update check
      // must never reach the console as an unhandled rejection, let alone stop
      // the shell from mounting
      .catch(() => {});
    return () => {
      off?.();
      offInstall?.();
    };
    // eslint's exhaustive-deps plugin isn't installed; bridge is stable
  }, [applyUpdateStatus]);

  const checkForUpdates = React.useCallback(() => {
    void bridge.update
      ?.check?.({ manual: true })
      .then((s) => applyUpdateStatus(s))
      .catch(() => {});
    // eslint's exhaustive-deps plugin isn't installed; bridge is stable
  }, [applyUpdateStatus]);

  /**
   * The Update button (E19-04).
   *
   * Two paths, and the RESULT decides which — not the button. A release with a
   * verifiable installer downloads in place; one without (an older release, a
   * platform we do not package for) opens its page in the browser, which is
   * exactly what E19-03 shipped and remains the fallback for every failure.
   */
  const startUpdate = React.useCallback(() => {
    const result = updateStatus?.result;
    if (!result) return;
    const install = bridge.update?.install;
    // No bridge, no progress bar. Checked BEFORE the optimistic status below:
    // the dialog is deliberately inescapable while a download is running, so
    // showing that face for an install that was never started would trap the
    // user behind a Cancel button with nothing to cancel.
    if (!result.download || typeof install !== 'function') {
      if (result.url) void bridge.update?.openExternal?.(result.url)?.catch(() => {});
      setUpdateOpen(false);
      return;
    }
    // Optimistic, so the dialog becomes a progress bar on the click rather than
    // on the first byte: main's own `downloading` push replaces this within
    // milliseconds, and a button that looks inert while a token is resolved is
    // a button people press twice.
    setInstallStatus({
      phase: 'downloading',
      version: result.latestVersion ?? '',
      received: 0,
      total: result.download.size,
      ...(result.url ? { url: result.url } : {}),
    });
    void install()
      .then((s) => setInstallStatus(s))
      // Fail-open: a rejected invoke (a broker refusal, a main-side crash) must
      // leave the user with a dialog they can close, not a progress bar that
      // never moves.
      .catch(() => setInstallStatus(null));
  }, [updateStatus]);

  /**
   * Closing the dialog without answering leaves the offer standing.
   *
   * Escape, click-away and a cancelled download all land here; Ignore and Skip
   * do not, because those ARE answers. This is the item's "the persistent
   * update available affordance remains".
   */
  const closeUpdateDialog = React.useCallback(() => {
    setUpdateOpen(false);
    const result = updateStatus?.result;
    const version = result?.latestVersion;
    if (result?.state !== 'available' || !version) return;
    if (version === ignoredVersion.current) return;
    // Not after a failed install: the user has just been sent to the release
    // page in their browser, and "ready to install" in the corner would be
    // both wrong and a second thing to dismiss.
    if (installStatus?.phase === 'failed') return;
    setUpdateNotice({ kind: 'available', version });
  }, [updateStatus, installStatus]);

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

  // Both list refreshes are async round-trips with SEVERAL independent triggers
  // (see the effects below), so two are routinely in flight at once — and the
  // one that resolves last is not necessarily the one that was issued last.
  // `latestWins` drops a response that a newer one has already overtaken;
  // without it a stale snapshot can permanently overwrite a terminal status
  // like `needs-permission`, and nothing ever arrives to heal it (#251). The
  // events list at the bottom of this file guards the neighbouring case — a
  // PUSH beating a `list()` still in flight — and keeps its own guard; this one
  // is pull-vs-pull and the two are not interchangeable.
  //
  // Each guard is built by a `useState` INITIALIZER rather than a `useMemo`,
  // because the guard's sequence counters are state and `useMemo` is a cache
  // React is allowed to throw away — a discarded guard is no guard. React's
  // contract for an initializer is exactly what is needed here: called once,
  // and the value it returns is stable for the component's lifetime. That
  // stability is also what keeps the dependency arrays below honest, as the
  // `useCallback`s these replace did.
  const [refreshSessions] = useState<GuardedRefresh>(() =>
    // bridge is stable for the window's lifetime
    latestWins(
      // card-keyed view: includes SUSPENDED cards (restored, not yet resumed)
      () => bridge.sessions?.cards?.(),
      (list) =>
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
        )
    )
  );

  const [refreshGroups] = useState<GuardedRefresh>(() =>
    latestWins(
      () => bridge.groups?.list?.(),
      (list) => sessionStore.setGroups(list as RailGroup[])
    )
  );

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
    // …and when a card gains or loses its live session without any status
    // having changed — a resume (#170). Same refresh, third trigger.
    const offCards = bridge.sessions?.onCardsChanged?.(() => void refreshSessions());
    return () => {
      offStatus?.();
      offExit?.();
      offCards?.();
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

  // ── reveal (and focus) on needs-attention (E9-05 + E9-10, §5.8) ──────────
  //
  // "Reveal triggers: needs-attention (permission / input / done) or user click
  // anywhere." The click half has worked since E15-08 — every click path lands
  // in GridController.focusSession, which reveals a card that has no panel.
  // This is the other half: a session that is collapsed, tabbed or hidden comes
  // BACK ON ITS OWN, into exactly the slot it left, the moment it needs a human.
  //
  // E9-05 shipped this taking focus from nobody, ever, and left the second
  // question — MAY it take the cursor? — to E9-10's focus-stealing policy. That
  // policy now answers it per session (lib/focus-policy), and its answer is
  // also what decides whether the reveal happens at all: `urgent` and `none`
  // leave the workspace alone entirely.
  //
  // Both rules are pure and unit-tested (lib/focus-policy's `attentionResponse`
  // decides, lib/ladder's `revealTargets` walks the feed); this effect is only
  // the wiring, and the ref is what makes "have I acted on this event id"
  // survive re-renders without being state nothing renders from.
  const revealSeen = React.useRef<ReadonlySet<number>>(new Set());
  const bootFeedSeeded = React.useRef(false);
  useEffect(() => {
    // Two things must be TRUE before this may act, and both are about not
    // reacting to a list nobody sent:
    //
    //  • the feed has actually delivered. The store starts with an empty events
    //    array, so this effect runs once before any IPC lands — spending the
    //    "seed, don't act" pass on a list that was never a list, and letting the
    //    first REAL one arrive looking like a burst of new events.
    //  • the grid exists. Marking ids seen with nobody to reveal them would
    //    retire the event for good, and that session would never come back for
    //    it.
    if (!sessionStore.hasFeed() || !grid.current) return;
    const plan = revealTargets(events, revealSeen.current, {
      cardIdFor: (liveId) => sessionStore.cardIdForLive(liveId),
      // dockview's answer, not the rung's: §5.8's `smart` turns on the word
      // "visible", and an `expanded` card can still be an unselected tab.
      onScreen: (cardId) => grid.current?.isCardOnScreen(cardId) ?? false,
      // The first list is SEEDED, never acted on: at boot the feed hands over
      // whatever was already waiting, and §5.25 says the workspace comes back
      // as the user left it — a launch that instantly un-collapses every
      // session that was blocked when you quit yesterday is not that.
      act: bootFeedSeeded.current,
      // Read from the STORE, not from the rendered `focusPolicies`: this effect
      // runs on the events identity change, and a policy set in the same commit
      // must not be one render stale when a session calls.
      respond: (cardId, onScreen) =>
        attentionResponse(sessionStore.focusPolicyFor(cardId), { visible: onScreen }),
    });
    revealSeen.current = plan.seen;
    bootFeedSeeded.current = true;
    // Two verbs, because they are two different things to a card that is
    // already on screen: placing it would move a panel for nothing (and would
    // drag a tabbed card out of its stack), while focusing it is the whole of
    // what `smart` does for a card you can see. The two lists are DISJOINT by
    // construction — revealTargets only lists a card for placing when it is off
    // screen — so the guard below is a statement of that, not a de-duplication.
    //
    // ORDER WITHIN ONE BATCH is deliberately not defined: if a single feed push
    // brought two sessions that both may focus, the last one to land wins, and
    // which that is depends on `revealCard` being async while `focusSession` is
    // not. Two sessions calling in the same frame is a coin toss either way, and
    // inventing a tie-break here would only make the coin look loaded.
    const placing = new Set(plan.cardIds);
    const focusing = new Set(plan.focusIds);
    for (const cardId of plan.cardIds) grid.current?.revealCard(cardId, focusing.has(cardId));
    for (const cardId of plan.focusIds) {
      // through App's own wrapper, not grid's: it records that a DIFFERENT OS
      // window was raised, which the popout key bridge below has to know
      if (!placing.has(cardId)) focusSession(cardId);
    }
  }, [events]);

  // ── layout modes react to the workspace (E9-07, §5.8) ────────────────────
  //
  // A mode is not a one-off rearrangement: `queue` has to expand a session THE
  // INSTANT it needs attention (the item's done-when, verbatim) and `focus` has
  // to move its big card to whatever you click. Both are "something moved
  // underneath the mode", which is exactly this effect — the sessions list (the
  // status machine's output) and the focused card.
  //
  // It is a no-op unless a mode is actually enforcing (lib/layout-mode's
  // `isEnforced`), and that is load-bearing: the DEFAULT mode is `grid`, whose
  // plan is "every session gets a card", so a standing grid sweep would
  // re-expand every card the user collapsed by hand on the next status change.
  // Grid is applied when you switch INTO it and never again.
  useEffect(() => {
    grid.current?.applyLayout('react');
  }, [layout, sessions, activeCard]);

  // ── keyboard commands (E9-01) ────────────────────────────────────────────
  // One document-level listener owns every binding; lib/commands decides
  // whether a key is ours to take (never in a text input, NEVER in a terminal).
  // Rail order is the numbering authority for Ctrl+1..9 — the same function the
  // rail renders from (collapsed groups included: collapsing hides rows, it
  // doesn't renumber the workspace).
  // the store derives rail order from the same sessions+groups the rail
  // renders, so Ctrl+1..9 numbering and the eye can never disagree
  const railHiddenRef = React.useRef(railHidden);
  // Read by the dispatcher: an open modal swallows the app's accelerators.
  // ANY modal, not just the palette (E15-15 added the About panel) — including
  // the two chords the browser process claims before the page sees them, which
  // would otherwise jump to a session hidden behind the dialog.
  const modalOpenRef = React.useRef(false);
  useEffect(() => {
    railHiddenRef.current = railHidden;
    modalOpenRef.current = paletteOpen || aboutOpen || updateOpen;
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


  // The mouse path for the layout mode (E9-07) — the titlebar chip. It cycles
  // rather than opening a picker, exactly as the presentation-policy chip does:
  // three states, and the label always says which one you are on.
  const cycleLayoutMode = React.useCallback(() => grid.current?.cycleLayoutMode(), []);

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
          closeAllCards: () => grid.current?.closeAllCards(),
          togglePin,
          toggleCardView: (cardId, view) => grid.current?.toggleCardView(cardId, view),
          popOutCard: (cardId) => grid.current?.popOutCard(cardId),
          hideCard: (cardId) => grid.current?.hideCard(cardId),
          setLadder: (cardId, rung) => grid.current?.setLadder(cardId, rung),
          stepLadder: (cardId, dir) => grid.current?.stepLadder(cardId, dir),
          setGlobalPolicy,
          setSessionPolicy,
          setGroupPolicy,
          setGlobalFocusPolicy,
          setSessionFocusPolicy,
          setLayoutMode: (mode) => grid.current?.setLayoutMode(mode),
          cycleLayoutMode: () => grid.current?.cycleLayoutMode(),
          toggleMaximize: (cardId) => grid.current?.toggleMaximize(cardId),
          toggleRail,
          openPalette: () => setPaletteOpen(true),
          toggleTabRows: () => {
            toggleTabRows();
          },
          jumpToNextAttention,
          openAbout: () => setAboutOpen(true),
          checkForUpdates,
      }),
    [
      toggleRail,
      jumpToNextAttention,
      setGlobalPolicy,
      setSessionPolicy,
      setGroupPolicy,
      setGlobalFocusPolicy,
      setSessionFocusPolicy,
      togglePin,
      checkForUpdates,
    ], // other deps read live state through refs; grid.current is stable
  );
  // chips advertise their own binding, derived from the registry so a tooltip
  // can never drift from the key that actually works
  const railBindingLabel = formatBinding(bindingFor(commands, 'view.rail'), platform);
  const paletteBindingLabel = formatBinding(bindingFor(commands, 'palette.open'), platform);
  const queueBindingLabel = formatBinding(bindingFor(commands, 'attention.next'), platform);
  const layoutBindingLabel = formatBinding(bindingFor(commands, 'layout.cycleMode'), platform);
  // the palette reads the SAME context the dispatcher does, at open time
  // ONE builder for both readers (the palette at open time, the dispatcher at
  // keypress time). They used to construct this separately, which is how a
  // command ends up enabled in the palette and dead on the keyboard.
  const commandContext = React.useCallback(() => {
    // read from the store, not a ref: this runs on KEYDOWN, outside React's
    // commit, so it has to see what is true now
    const activeCardId = grid.current?.activeCardId() ?? null;
    return {
      sessions: sessionStore.getRailOrder().flat,
      activeCardId,
      // resolved HERE, once, so the palette's enabled state and the keyboard's
      // both come from the same read (E9-06's group-level commands)
      activeGroupId: activeCardId
        ? (sessionStore.getState().sessions.find((s) => s.id === activeCardId)?.groupId ?? null)
        : null,
      attentionCount: sessionStore.getQueue().length,
    };
  }, []);
  const focusCard = React.useCallback((cardId: string) => focusSession(cardId), [focusSession]);
  const popoutKeysRef = React.useRef(new Map<Window, (e: KeyboardEvent) => void>());
  useEffect(() => {
    // Returns the command that ran (or null) — the popout bridge below needs
    // the REAL answer, not a guess from e.defaultPrevented: the composer
    // preventDefaults its own Enter, and mistaking that for a command would
    // yank this window in front of the one being typed in.
    const onKey = (e: KeyboardEvent): unknown => {
      // while a modal owns the screen, nothing underneath it fires —
      // regardless of where focus ended up inside the modal
      if (modalOpenRef.current) return null;
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
    // not silently deafened. It maps a window to ITS handler and nothing more —
    // which windows are open is `lib/popout-windows`' answer, not a second copy
    // kept here (#227).
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
      // Forget it FIRST, then try to unhook. Since #279 this runs routinely for
      // a window that is definitively closed — the registry now drops those
      // itself, which is what sends them down here — and a dead Window is only
      // ALMOST certainly still a working EventTarget. If it ever were not, doing
      // these the other way round would keep the handler and the dead window in
      // this map forever, which is precisely the leak #279 closed, and (in the
      // loop below, outside any try) would abort the effect before it
      // subscribes, leaving every popout deaf.
      popoutKeys.delete(win);
      try {
        win.removeEventListener('keydown', handler);
      } catch {
        /* nothing left to detach from — fail open, the listener died with it */
      }
    };
    // Re-attach anything open before this (re-)run, from the REGISTRY rather
    // than from our own leftovers — that is the authority on what exists, and
    // this map is only "what I have a handler for". They can differ in one
    // direction: a popout closed while this effect was torn down leaves a key
    // behind that no `removed` will ever come for, so drop those first (dead
    // Windows are inert, but they are still retained forever).
    const open = new Set(openPopoutWindows());
    for (const win of [...popoutKeys.keys()]) if (!open.has(win)) detach(win);
    for (const win of open) {
      detach(win);
      attach(win);
    }
    const offPopouts = subscribePopoutWindows({
      added: (win) => {
        attach(win); // no-op for a window re-announced with its handler intact
        // a popout is its own document: give it our theme + tab-row flags (#84).
        // Unconditionally, including on a re-announcement — a reused window is a
        // fresh document with neither flag nor token overlay on it, and an
        // unthemed popout is the failure this call exists to prevent.
        syncDocumentFlags([win]);
      },
      removed: detach,
    });

    return () => {
      window.removeEventListener('keydown', onKey);
      offPopouts();
      // detach the LISTENERS but keep the window keys: a re-run re-attaches
      // them above with fresh handlers. (A popout closed during app teardown
      // may not fire its remove event — a dead Window in the map is inert.)
      for (const [win, handler] of popoutKeys) win.removeEventListener('keydown', handler);
    };
  }, [commands, platform, commandContext]);

  // ── the two chords claimed ABOVE the renderer (#90) ───────────────────────
  // The palette and the attention jump have to work from inside a session
  // terminal — §5.8's invariant is that capability never goes away, and from an
  // xterm every accelerator is deaf by design (the CLI owns every key it sees).
  // So the browser process claims exactly those two chords in
  // before-input-event, where nothing competes with the PTY, and sends the
  // COMMAND ID here. They therefore never arrive as a keydown at all; this is
  // their only path in the running app, and it runs the same registered
  // command the palette and the keyboard run.
  useEffect(() => {
    return bridge.onAccelerator?.(({ commandId, fromPopout }) => {
      // while a modal owns the screen, nothing underneath it fires — the
      // same guard the keydown dispatcher applies
      if (modalOpenRef.current) return;
      // Only the popouts we know about are searched — the registry is filled by
      // SessionGrid from dockview's own event (#227), so a window that somehow
      // missed it lands on the fallback and simply behaves as if nothing were
      // focused.
      const target = fromPopout ? focusedElementIn(openPopoutWindows(), document) : document.activeElement;
      raisedOtherWindowRef.current = false;
      const ran = dispatchAccelerator(
        commandId,
        commands,
        commandContext(),
        target,
        (err, id) => console.error(`[commands] ${id} failed`, err),
      );
      // Pressed in a popped-out window: what these commands show — the palette,
      // the grid — is in THIS window, so bring it forward. Unless the command
      // deliberately raised a different one (jumping to another popped-out
      // session), which is the same exception the keydown bridge makes.
      if (fromPopout && ran && !raisedOtherWindowRef.current) window.focus();
    });
    // eslint's exhaustive-deps plugin isn't installed; bridge is stable
  }, [commands, commandContext]);

  if (!uiReady) return <div style={{ blockSize: '100vh' }} />; // one-frame gate while UI state loads

  return (
    <div style={{ blockSize: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TitleBar
        version={bridge.appVersion}
        identity={BUILD_IDENTITY}
        onOpenAbout={() => setAboutOpen(true)}
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
        presentationPolicy={policies.global}
        onCyclePresentationPolicy={cycleGlobalPolicy}
        layoutMode={layout.mode}
        layoutMaximized={layout.maximized !== null}
        onCycleLayoutMode={cycleLayoutMode}
        layoutBinding={layoutBindingLabel}
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
      <AboutPanel
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        version={bridge.appVersion}
        identity={BUILD_IDENTITY}
        platform={bridge.platform}
        onCheckForUpdates={checkForUpdates}
        autoCheck={autoCheckUpdates}
        onToggleAutoCheck={(on) => {
          setAutoCheckUpdates(on); // optimistic, so the tick moves at once…
          void bridge.update
            ?.setPrefs?.({ autoCheck: on })
            // …then main's sanitized answer wins: it is the authority, and a
            // refused write must not leave the box saying otherwise
            .then((p) => setAutoCheckUpdates(p.autoCheck !== false))
            .catch(() => {});
        }}
        // a second dialog is above this one: two stacked `aria-modal` regions
        // is a thing screen readers disagree about, so only the top one claims it
        dialogAbove={updateOpen}
      />
      <UpdateDialog
        open={updateOpen}
        status={updateStatus}
        install={installStatus}
        onClose={closeUpdateDialog}
        onUpdate={startUpdate}
        onOpenUrl={(url) => void bridge.update?.openExternal?.(url)?.catch(() => {})}
        onCancelInstall={() => void bridge.update?.cancelInstall?.()?.catch(() => {})}
        onIgnore={(version) => {
          ignoredVersion.current = version;
          // An answer, so the corner nudge goes too — including one left over
          // from an earlier close of the same release.
          setUpdateNotice(null);
        }}
        onSkip={(version) => {
          setUpdateNotice(null);
          void bridge.update?.setPrefs?.({ skippedVersion: version })?.catch(() => {});
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        contextOf={commandContext}
        focusCard={focusCard}
        platform={platform}
      />
      {/* shows nothing unless the workspace cannot be saved — either the file
          is from a newer build (#168) or the writes themselves keep failing
          (#207). It reads and follows both itself */}
      <WorkspaceNoticeBanner />
      {/* rendered unconditionally, and gated INSIDE: its live region has to
          exist before the preflight answer lands or the warning is announced to
          nobody (#222). Same reason as its sibling above. */}
      <PreflightBanner shown={!preflightOk} />
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
      {/* §5.8's second rung. Outside the grid for the same reason the lamps
          are — the grid is what a collapsed card has just left. Renders
          nothing when nothing is collapsed. */}
      <CollapsedStrip
        rows={collapsed}
        activeCardId={activeCard}
        onExpand={(cardId) => focusCard(cardId)}
      />
      {/* §5.8's batch prompt (P2-E9-11). LAST in the stack of bands, directly
          above the workspace, on purpose: it is the only one of them that comes
          and goes with events rather than with the user's own actions, and
          anywhere higher it would shove the two permanent strips down the
          screen every time a fleet parked. Renders nothing when nothing groups.
          Outside the grid for the reason the strips are — a group spans cards,
          and dockview has not mounted most of them. */}
      <BatchApprovalBar batch={permissionBatch} members={batchMembers} onDecide={decideBatch} />
      {/* The one child of this column that is MEANT to give. `flex: 1` is
          `flex: 1 1 0%` — a basis of ZERO — and a flex container shares out
          negative free space in proportion to each item's shrink factor times
          its basis, so this absorbs NOTHING: in a window too short for the
          stack, every missing pixel comes off the auto-basis bars above and
          below instead. That is the intent (the workspace is what should be
          squeezed), and it is also why every one of those bars has to opt out
          by hand with `flexShrink: 0`. always-visible-notices.test.ts rosters
          them; this is the line that makes the roster necessary. */}
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
            /* These three are the `groups:*` calls that come back with an
               ANSWER, and like every other bridge call in this file they are
               uncaught (#326). They no longer need to be caught: main resolves
               `null` instead of throwing when it refuses a change, so a refusal
               is a value to read rather than a rejection nobody is listening
               for. `groupChangeLanded` reads it; the refresh runs either way,
               which is what makes a refused edit revert to the truth.
               `remove` and `setSessionGroup` below answer nothing and refuse
               the same way — quietly, with a line in the log. */
            onCreateGroup={(name) => {
              void bridge.groups?.create?.({ name }).then((made) => {
                groupChangeLanded('create', made);
                return refreshGroups();
              });
            }}
            onRenameGroup={(id, name) => {
              void bridge.groups?.update?.(id, { name }).then((next) => {
                groupChangeLanded('rename', next);
                return refreshGroups();
              });
            }}
            onRecolorGroup={(id, color) => {
              void bridge.groups?.update?.(id, { color }).then((next) => {
                groupChangeLanded('recolor', next);
                return refreshGroups();
              });
            }}
            policies={policies}
            pinned={pinned}
            onTogglePin={togglePin}
            onSetSessionPolicy={setSessionPolicy}
            onCycleGroupPolicy={cycleGroupPolicy}
            focusPolicies={focusPolicies}
            onSetSessionFocusPolicy={setSessionFocusPolicy}
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
          queueEvents={attentionFeed}
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
          updateNotice={updateNotice}
          onUpdateNow={() => {
            setUpdateNotice(null);
            setUpdateOpen(true);
          }}
          onDismissUpdateNotice={() => setUpdateNotice(null)}
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
