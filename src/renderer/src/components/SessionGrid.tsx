// Session grid (P1-E3-01): Dockview-powered card grid. Cards are placeholders
// until E3-02 wires terminals in. Layout serializes to the workspace store on
// every change and restores on boot.
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DockviewReact,
  DockviewReadyEvent,
  DockviewApi,
  DockviewTheme,
  IDockviewPanel,
  IDockviewPanelProps,
  PopoutGroup,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
// AFTER dockview's own sheet: binds every --dv-* variable to our tokens so the
// shell, popups and popout windows can't fall back to a foreign theme (#84)
import '../theme/dockview-tokens.css';
import { rendererRegistry } from '../extensibility/registry-instance';
import { sessionStore } from '../store/session-store';
import { DEFAULT_PANEL_ID, PanelContext, PanelId } from '../extensibility/contributions';
import { listPanels, panelBadge, panelEnabled } from '../extensibility/panels';
import { ContributionBoundary } from '../extensibility/boundary';
import { IdentityChip } from './IdentityChip';
import { DiffPane } from './DiffPane';
import { UsageStrip } from './UsageStrip';
import { GitContext, GitStatusDto } from './GitContext';
import { Usage, ZERO_USAGE } from '../lib/usage';
import type { BindingDiagnostics, BindingState } from '../../../shared/transcripts';
import { Box, boxOnAnyDisplay, RescuedPopout, sanitizePopoutLayout, WorkArea } from '../lib/layout';
import { captureSlot, openerRelative, placeAt } from '../lib/dock-slot';
import { hasPanel, slotIsLive, stepDown, stepUp } from '../lib/ladder';
import { submitTarget } from '../lib/presentation-policy';
import { createSweeper, SweepPort, SweepRequest } from '../lib/layout-sweep';
import {
  cycleMode,
  isEnforced,
  LayoutCard,
  LayoutMode,
  LayoutTrigger,
  plan as layoutPlan,
  snapshotRungs,
  withMaximized,
  withMode,
  withoutMaximized,
} from '../lib/layout-mode';
import { presentStatus } from '../lib/rail-view';
import { tabStripAction } from '../lib/tabstrip-keys';
import { cardHeaderTitle } from '../lib/card-title';
import { StatusPill } from './StatusPill';
import type { Ladder } from '../lib/presentation';
import { pickAdoptedGroupId } from '../lib/groups';
import { addPopoutWindow, removePopoutWindow } from '../lib/popout-windows';
import { uiGet, uiSet } from '../lib/ui-state';
import { setDraggedCard } from '../lib/drag-context';
import { writePromptToPty } from '../lib/composer';

/** Subscribe helper for useSyncExternalStore — module-level so its identity is
 *  stable across renders (a fresh function resubscribes every commit). */
const subscribeStore = (cb: () => void): (() => void) => sessionStore.subscribe(cb);

// The DURABLE unit is the card (cardId + folder). The live claude session
// under it is ephemeral: spawned — or --resumed — lazily the first time the
// card is visible (resume-on-focus, §5.25). Params carry only stable data so
// they survive Dockview layout serialization across restarts.
export interface CardParams {
  cardId: string;
  folder: string;
  title?: string;
  /** persistent-group membership at creation (E12); undefined = ungrouped */
  groupId?: string;
}

interface Live {
  id: string;
  accent?: string;
  badge?: string;
  autonomy?: string;
  /** the record's status at bind time — a card that ADOPTED a running session
   *  (reveal, P2-E15-08) must not claim 'starting': no further push is coming
   *  for an idle session, and the card would sit there lying about it */
  status?: string;
  /** which transport hosts it (P2-E18-08b) — the Terminal tab needs to know */
  transport?: 'pty' | 'stream';
}

export function IdentityTab(props: IDockviewPanelProps<CardParams>): React.JSX.Element {
  const { t } = useTranslation();
  const cardId = props.params?.cardId;
  // What the TAB calls the session, on screen and in its close confirmation
  // (#264) — the store's copy first, exactly as the card header does it.
  // dockview is told a panel's title once, at `addPanel`, and nothing in the
  // tree ever calls `setTitle`, so `props.api.title` is the name the tab was
  // born with: a rename from the rail reaches the record, the rail and the
  // header, and stops at this strip.
  //
  // A DERIVED tab (diff) carries no cardId, so the store has no answer for it
  // and its dockview title still wins — which is right: nobody renames a diff.
  const storeTitle = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getCardTitle(cardId)
  );
  const title = cardHeaderTitle(
    storeTitle,
    props.api.title || props.params?.title,
    props.params?.folder
  );
  return (
    <div style={{ paddingInline: 8, display: 'flex', alignItems: 'center', gap: 4, blockSize: '100%' }}>
      <IdentityChip title={title} compact />
      <button
        onClick={(e) => {
          // close the tab: for a session card this ends the session AND
          // forgets the record (onDidRemovePanel -> closeCard) — so it
          // CONFIRMS first (Dan 2026-07-22); derived tabs (diff) just close
          e.stopPropagation();
          if (cardId) {
            if (!window.confirm(t('grid.closeConfirm', { title }))) return;
          }
          props.api.close();
        }}
        onMouseDown={(e) => e.stopPropagation()} // don't start a tab drag
        title={t('grid.closeTab')}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--faint)',
          cursor: 'pointer',
          fontSize: 10,
          lineHeight: 1,
          padding: '0 3px 6px',
          borderRadius: 3,
          // pushed up-and-right, away from the click path to the tab itself
          marginInlineStart: 14,
          alignSelf: 'flex-start',
        }}
      >
        {t('grid.closeTabIcon')}
      </button>
    </div>
  );
}

function SessionCardPanel(props: IDockviewPanelProps<CardParams>): React.JSX.Element {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState<boolean>(props.api.isVisible);
  const [live, setLive] = React.useState<Live | null>(null);
  const [exited, setExited] = React.useState<{ code: number; crashed: boolean } | null>(null);
  const [usage, setUsage] = React.useState<{ usage: Usage; model?: string } | null>(null);
  const [binding, setBinding] = React.useState<{
    binding: BindingState;
    bindingDiag: BindingDiagnostics | null;
  } | null>(null);
  const [plan, setPlan] = React.useState<{ total: number; completed: number; inProgress: number } | null>(null);
  const [taskLabel, setTaskLabel] = React.useState<string>('');
  const [editingLabel, setEditingLabel] = React.useState(false);
  // which view tab the keyboard is on, when it is not the selected one (#197).
  // `null` = focus is outside the strip, so the roving stop sits on the
  // selection again.
  const [tabFocus, setTabFocus] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>('starting');
  const cardId = props.params?.cardId;
  // PRESENTATION STATE LIVES IN THE STORE (P2-E15-08, AR-P1-5), not here.
  //
  // The view tab, the popped-out flag and the suspended flag all have to
  // outlive this panel: hiding a card unmounts it, and §5.8's reveal contract
  // is "restores it to exactly where it was". They also have to be writable by
  // things that are not this card — the palette, and E9-07's layout modes,
  // which rearrange every session at once.
  //
  // The Session view is the default (§5.10; the internal view id stays 'feed').
  // The Terminal is ALWAYS present as the LAST tab (owner reversal 2026-07-22 —
  // hide-by-default lasted one day of dogfooding).
  const presentation = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getPresentation(cardId)
  );
  // The session's CURRENT title, for panels that have to name themselves
  // (#196 — the Session view's landmark). Read from the store rather than from
  // `props.api.title`: dockview is told a panel's title once, when the card is
  // created, and a rename from the rail goes to the main process and comes
  // back through `setSessions` — so the panel api's copy is the title the card
  // had at birth.
  const cardTitle = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getCardTitle(cardId)
  );
  const view = presentation.view;
  const poppedOut = presentation.poppedOut;
  const suspended = presentation.suspended;
  // A panel with no cardId (the dev seed panels) has no durable identity, so
  // its writes are dropped by the store — it also never reaches the tab strip,
  // which only renders for a live session.
  const setView = (v: PanelId): void => sessionStore.setPresentation(cardId, { view: v });
  // per-card autonomy for the composer options row (E10-05): persists to the
  // record and applies on the NEXT spawn/resume (the CLI can't switch live)
  const [cardAutonomy, setCardAutonomy] = React.useState<string | undefined>(undefined);
  const cycleCardAutonomy = (): void => {
    if (!cardId) return;
    const order = ['ask', 'plan', 'auto-edit', 'full-auto'];
    const next = order[(order.indexOf(cardAutonomy ?? 'ask') + 1) % order.length];
    setCardAutonomy(next);
    void window.switchboard.sessions.setAutonomy(cardId, next);
  };
  // per-card transport (P2-E18-08b). Applies on the NEXT spawn, exactly like
  // autonomy above — the CLI cannot change either on a live session. It is
  // ACCEPTED either way; when a session is running we say the change is queued
  // rather than implying it took effect.
  const [cardTransport, setCardTransport] = React.useState<'pty' | 'stream'>('pty');
  const [transportPending, setTransportPending] = React.useState(false);
  const toggleTransport = (): void => {
    if (!cardId) return;
    const next = cardTransport === 'stream' ? 'pty' : 'stream';
    void window.switchboard.sessions.setTransport(cardId, next).then((r) => {
      if (!r.ok) return;
      setCardTransport(next);
      setTransportPending(!!r.pending);
    });
  };
  // held permissions awaiting decisions (E10-04) — a QUEUE, not a slot:
  // parallel tool calls each hold their own request (review P0#4)
  const [permQueue, setPermQueue] = React.useState<
    Array<{
      requestId: string;
      sessionId: string;
      tool: string;
      input: Record<string, unknown>;
      /** the CLI's own prose for WHY (P2-E18-07) — stream transport only */
      reason?: string;
    }>
  >([]);
  const perm = permQueue[0] ?? null;
  // ⋯ session-controls menu (E10-07, §5.17): GUI sugar that TYPES the real
  // slash command into the PTY — the CLI stays the source of truth
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  // locked while starting (§5.10 startup-dialog rule) or once the live
  // session is gone — a PTY write to a dead session is a silent no-op
  const controlsLocked = status === 'starting' || status === 'crashed' || exited !== null;
  const spawning = React.useRef(false);
  const folder = props.params?.folder;

  React.useEffect(() => {
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);

  // dockview is the authority on WHERE the panel is; the store mirrors it so
  // that layout modes and the palette can ask without mounting the card. Sync
  // on mount, because a revealed panel is created directly into its slot.
  React.useEffect(() => {
    const poppedOut = props.api.location.type === 'popout';
    // A MOUNTED PANEL IS IN THE WORKSPACE, whatever the blob says. The rung is
    // written before dockview's (microtask-buffered) layout save, so a quit in
    // between could restore a card that has a panel AND claims a panel-less
    // rung — and nothing else would ever correct it, because reveal
    // early-returns when a panel already exists. Dockview wins.
    //
    // `hasPanel` and not an `=== 'hidden'` test (P2-E9-05): `collapsed` is the
    // second panel-less rung and would otherwise leave a card mounted in the
    // grid AND listed in the collapsed strip — visibly in two places at once.
    const rung = sessionStore.getPresentation(cardId).ladder;
    sessionStore.setPresentation(
      cardId,
      hasPanel(rung) ? { poppedOut } : { poppedOut, ladder: 'expanded' }
    );
  }, [cardId, props.api]);

  // resume-on-focus: spawn (or --resume) the session when the card first
  // becomes visible. Background restored cards stay suspended until touched.
  React.useEffect(() => {
    if (!visible || live || exited || suspended || spawning.current || !cardId || !folder) return;
    spawning.current = true;
    // titlebar autonomy chip applies to NEW cards; main keeps a card's own
    // autonomy across resumes
    const stored = uiGet<string>('autonomy', 'ask');
    const autonomy =
      stored === 'plan' || stored === 'auto-edit' || stored === 'full-auto' ? stored : 'ask';
    void window.switchboard.sessions
      .create({ cardId, folder, title: props.api.title ?? folder, autonomy, groupId: props.params?.groupId })
      .then((record) => {
        if (cardId) sessionStore.mapLiveToCard(record.id, cardId);
        setLive({
          id: record.id,
          accent: record.identity.accentColor,
          badge: record.identity.langBadge,
          autonomy: record.autonomy,
          status: record.status,
          transport: record.transport,
        });
        // show the usage strip from the start (zeros until the first prompt),
        // so it's visibly present rather than appearing only after activity
        setUsage({ usage: record.priorUsage ?? ZERO_USAGE, model: record.priorModel });
        if (record.taskLabel) setTaskLabel(record.taskLabel);
        setCardAutonomy(record.autonomy ?? 'ask');
        // the card's stored choice, so the menu shows what will happen NEXT spawn
        setCardTransport(record.transport === 'stream' ? 'stream' : 'pty');
      })
      .catch(() => {
        setExited({ code: -1, crashed: true }); // spawn failed — show the overlay
      })
      .finally(() => {
        spawning.current = false;
      });
  }, [visible, live, exited, suspended, cardId, folder, props.api.title]);

  // a dead session's card must be dismissable, not a stuck blank terminal
  React.useEffect(() => {
    if (!live) return;
    return window.switchboard.sessions.onExited((e) => {
      if (e.sessionId === live.id) setExited({ code: e.code, crashed: e.crashed });
    });
  }, [live]);

  // live token usage for this session (P2-E7-01), and — riding the same
  // snapshot — its transcript binding state (P2-E15-10)
  React.useEffect(() => {
    if (!live) return;
    return window.switchboard.sessions.onUsage((snap) => {
      const s = snap as {
        sessionId: string;
        usage: Usage;
        model?: string;
        plan?: { total: number; completed: number; inProgress: number };
        binding?: BindingState;
        bindingDiag?: BindingDiagnostics;
      };
      if (s.sessionId !== live.id) return;
      setUsage({ usage: s.usage, model: s.model });
      setPlan(s.plan && s.plan.total > 0 ? s.plan : null);
      if (s.binding) setBinding({ binding: s.binding, bindingDiag: s.bindingDiag ?? null });
    });
  }, [live]);

  // Binding state for a card that MOUNTS after the fact: a session that failed
  // to bind ten minutes ago will never push another snapshot, and without this
  // pull its pane would claim "no conversation yet" for the rest of the run.
  React.useEffect(() => {
    if (!live) return;
    // Drop the OLD session's answer first. A card whose session was restarted
    // or resumed gets a brand-new live id, and without this the `prev ??`
    // below — which exists to protect a newer live push from a slower reply —
    // would preserve the DEAD session's state instead, so a fresh healthy
    // session would inherit the red "couldn't find this transcript" banner
    // from the one it replaced, with no push coming to clear it.
    setBinding(null);
    let cancelled = false;
    void window.switchboard.transcripts.binding(live.id).then((b) => {
      // A live push that landed while this was in flight is NEWER than what we
      // asked for — it must not be overwritten by the reply.
      if (!cancelled && b) setBinding((prev) => prev ?? { binding: b.binding, bindingDiag: b.bindingDiag });
    });
    return () => {
      cancelled = true;
    };
  }, [live]);

  // git context (P2-E7-02): refresh when the card is shown and after each
  // turn ends (Stop -> done), since that's when files have changed
  const [git, setGit] = React.useState<GitStatusDto | null>(null);
  React.useEffect(() => {
    if (!live || !visible || !folder) return;
    let cancelled = false;
    const refresh = () => {
      void window.switchboard.git.status(folder).then((s) => {
        if (!cancelled) setGit(s as GitStatusDto);
      });
    };
    refresh();
    const off = window.switchboard.sessions.onStatus((c) => {
      const change = c as { sessionId: string; to: string };
      if (change.sessionId === live.id && change.to === 'done') refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [live, visible, folder]);

  // live status for the header pill (E8-05). Backend emits { sessionId, to }.
  // Spawn starts at the RECORD's status — never assume "working" (Dan
  // 2026-07-22: resumed sessions showed the working banner doing nothing).
  React.useEffect(() => {
    if (!live) return;
    setStatus(live.status ?? 'starting');
    return window.switchboard.sessions.onStatus((c) => {
      const s = c as { sessionId: string; to?: string };
      if (s.sessionId === live.id && s.to) setStatus(s.to);
    });
  }, [live]);

  // inline approvals (E10-04): held PreToolUse requests for THIS card queue
  // into a review bar; allow-all answers future ones for the LIVE session
  // only (review P0#2 — a respawn must prompt again). A hold needs eyes, so
  // it surfaces the Session tab whatever tab is active (review P0#5).
  React.useEffect(() => {
    if (!cardId) return;
    const enqueue = (r: {
      requestId: string;
      sessionId: string;
      cardId?: string;
      tool: string;
      input: Record<string, unknown>;
      /** stream transport only (P2-E18-07): the CLI's own prose for WHY */
      reason?: string;
    }): void => {
      if (r.cardId !== cardId) return;
      if (sessionStore.isAllowAll(r.sessionId)) {
        void window.switchboard.sessions.decidePermission(r.requestId, 'allow');
        return;
      }
      setPermQueue((prev) =>
        prev.some((p) => p.requestId === r.requestId)
          ? prev
          : [
              ...prev,
              {
                requestId: r.requestId,
                sessionId: r.sessionId,
                tool: r.tool,
                input: r.input,
                // Field-by-field, so a new field is a DECISION rather than a
                // silent pass-through — but that also means forgetting one is
                // silent. `reason` was dropped exactly this way and only the
                // e2e caught it; the unit tests all passed.
                reason: r.reason,
              },
            ]
      );
      setView(DEFAULT_PANEL_ID);
    };
    const offReq = window.switchboard.sessions.onPermissionRequest(enqueue);
    const offRes = window.switchboard.sessions.onPermissionResolved((r) => {
      setPermQueue((prev) => prev.filter((p) => p.requestId !== r.requestId));
    });
    // replay holds that arrived before this card subscribed (reload / mount
    // race) — a missed push must never park the CLI (review P0#3)
    void window.switchboard.sessions.pendingPermissions().then((list) => list.forEach(enqueue));
    return () => {
      offReq();
      offRes();
    };
    // setView identity is stable enough here; cardId is the real key (the
    // exhaustive-deps plugin isn't installed in this repo)
  }, [cardId]);
  const decide = (decision: 'allow' | 'deny', allowAll = false): void => {
    const head = permQueue[0];
    if (!head) return;
    if (allowAll) {
      // main answers future gated calls at the server — no hold/event/beep
      // (P2 #19). The local set still drains anything ALREADY queued here.
      sessionStore.setAllowAll(head.sessionId);
      void window.switchboard.sessions.allowAllSession(head.sessionId);
    }
    void window.switchboard.sessions.decidePermission(head.requestId, decision);
    setPermQueue((prev) => prev.slice(1)); // resolved event prunes too (idempotent)
    // The queue pops NOW; `permission-resolved` only comes back after a full
    // IPC round trip, so for a frame or two the card reads
    // "needs-permission with nothing held" — which is exactly the state the
    // handoff bar exists for. Without this window, answering a permission
    // flashes "switchboard can't answer it for you" where the button was
    // (#125 review). The window is generous on purpose: it costs nothing if
    // the status beats it, and a stale bar is worse than a late one.
    setRecentlyDecided(true);
  };
  const [recentlyDecided, setRecentlyDecided] = React.useState(false);
  React.useEffect(() => {
    if (!recentlyDecided) return;
    const id = setTimeout(() => setRecentlyDecided(false), 2_000);
    return () => clearTimeout(id);
  }, [recentlyDecided]);
  // a new hold means the round trip finished and the next question is live
  React.useEffect(() => {
    if (perm) setRecentlyDecided(false);
  }, [perm]);

  // membership follows the panel when the user drags it between dockview
  // groups in the grid (E12-04)
  React.useEffect(() => {
    const d = props.api.onDidGroupChange(() => {
      if (sessionStore.isTearingDown() || sessionStore.isRestoringLayout()) return;
      // A LADDER move is not a user drag (P2-E9-05). dockview fires this from
      // the plain group setter, so our own `moveTo` is indistinguishable from a
      // tab being dragged — and adopting from it would let a presentation
      // change rewrite the session's persistent group: tabbing a card would
      // move it into its stack-mate's group, and expanding it into a fresh
      // group (no siblings) would adopt `null` and ERASE the membership the
      // user made. Same guard as isHiding two handlers down.
      if (cardId && sessionStore.isMoving(cardId)) return;
      void adoptMembershipFromDockGroup(props);
    });
    return () => d.dispose();
    // props.api is stable for the panel's lifetime
  }, [props.api, cardId]);

  // Track popout location + implement the two dock-back semantics (E8-04):
  // the pop-out BUTTON toggling in keeps the session alive; the user closing
  // the OS window suspends it (keep the card + record, resume on reopen).
  React.useEffect(() => {
    const prev = { type: props.api.location.type as string };
    const d = props.api.onDidLocationChange(() => {
      const now = props.api.location.type as string;
      const wasPopout = prev.type === 'popout';
      prev.type = now;
      sessionStore.setPresentation(cardId, { poppedOut: now === 'popout' });
      // App quit tears popouts down — not a user close. If this ever loses the
      // race with beforeunload the only effect is the session ending a few ms
      // early: dropLive keeps the persisted record, so the card still resumes
      // next launch. Harmless either way (E8-04 review).
      if (sessionStore.isTearingDown()) return;
      // hiding a popped-out card removes its panel, which closes the window —
      // that is US, not the user, and it must NOT suspend the session (E15-08)
      if (cardId && sessionStore.isHiding(cardId)) return;
      // ...and neither is a LADDER move (P2-E9-05). Moving a popped-out card
      // into the grid to expand or stack it takes its window down, which looks
      // exactly like the user closing it — and would suspend a session for a
      // rung change. Unreachable from the palette today (activeCardId ignores
      // popouts), but E9-07's layout modes drive every card including those.
      if (cardId && sessionStore.isMoving(cardId)) return;
      if (wasPopout && now !== 'popout' && cardId) {
        // takeDockingBack CONSUMES the flag: a button toggle keeps the session
        // alive, a bare window close suspends it, and the two look identical
        // to dockview (E8-04)
        if (!sessionStore.takeDockingBack(cardId)) {
          void window.switchboard.sessions.dropLive(cardId); // window closed: suspend
          sessionStore.forgetCardLiveIds(cardId);
          setLive(null);
          sessionStore.setPresentation(cardId, { suspended: true });
        }
      }
    });
    return () => d.dispose();
  }, [props.api, cardId]);

  const closeSelf = (): void => {
    const panel = props.containerApi.getPanel(props.api.id);
    if (panel) props.containerApi.removePanel(panel); // onDidRemovePanel -> closeCard
  };
  // The pop-out toggle is a MODULE function (P2-E15-08): a command may target a
  // card that is not mounted — hidden, or being rearranged by a layout mode —
  // so it cannot live in this component's closure. The header button and the
  // command path now call one implementation.
  const popOutToggle = (): void => {
    if (cardId) popOutCardPanel(props.containerApi, cardId);
  };

  const resumeSelf = (): void => {
    // clear the suspended gate; the lazy-spawn effect re-fires while visible
    sessionStore.setPresentation(cardId, { suspended: false });
    setExited(null);
    spawning.current = false;
  };
  const restartSelf = (): void => {
    // drop the dead live session (keep the card record), then re-arm the lazy
    // spawn so the card respawns/resumes
    if (cardId) void window.switchboard.sessions.dropLive(cardId);
    if (live) sessionStore.forgetCardLiveIds(cardId ?? '');
    setExited(null);
    setLive(null);
    spawning.current = false;
  };
  const exitedOverlay = exited ? (
    <div>
      <div style={{ color: 'var(--text)', fontSize: 13, marginBlockEnd: 4 }}>
        {t('grid.sessionEnded')}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginBlockEnd: 12 }}>
        {exited.crashed ? t('grid.exitCrashed', { code: exited.code }) : t('grid.exitClean')}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button onClick={restartSelf} style={overlayBtn(true)}>
          {t('grid.restart')}
        </button>
        <button onClick={closeSelf} style={overlayBtn(false)}>
          {t('grid.close')}
        </button>
      </div>
    </div>
  ) : null;
  const suspendedOverlay = suspended ? (
    <div>
      <div style={{ color: 'var(--text)', fontSize: 13, marginBlockEnd: 4 }}>
        {t('grid.suspended')}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginBlockEnd: 12, maxInlineSize: 260 }}>
        {t('grid.suspendedHint')}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button onClick={resumeSelf} style={overlayBtn(true)}>
          {t('grid.resume')}
        </button>
        <button onClick={closeSelf} style={overlayBtn(false)}>
          {t('grid.close')}
        </button>
      </div>
    </div>
  ) : null;
  const changed = git?.files.length ?? 0;
  // Contributed view tabs (§5.23). The strip and the panel bodies below both
  // render from this list, so a new tab is a contribution plus a bootstrap
  // line — this file is not edited again.
  const panelCtx: PanelContext = {
    sessionId: live?.id ?? '',
    cardId,
    // The store's answer first; `props.api.title` only as the boot-order net
    // (a card mounts before the first `setSessions` lands). Deliberately NOT
    // falling through to `folder` after that: an absolute path is a poor thing
    // to hear announced, and a panel with no title at all says the honest
    // generic instead.
    title: cardTitle ?? props.api.title,
    visible,
    folder,
    ...docTheme(),
    status,
    transport: live?.transport,
    autonomy: cardAutonomy,
    model: usage?.model,
    binding: binding?.binding,
    bindingDiag: binding?.bindingDiag ?? null,
    recentlyDecided,
    changed,
    approval: perm,
    approvalQueued: Math.max(0, permQueue.length - 1),
    onDecide: decide,
    onCycleAutonomy: cycleCardAutonomy,
    setView,
  };
  const panels = listPanels(rendererRegistry);
  // ids for the tab <-> panel wiring (#197). `useId` because a workspace shows
  // many cards at once and every one of them renders the same four tab names —
  // hand-rolled ids would collide the moment a second card is open, and an
  // `aria-controls` pointing at another card's panel is worse than none.
  const tabsId = React.useId();
  const tabId = (id: string): string => `${tabsId}tab-${id}`;
  const tabPanelId = (id: string): string => `${tabsId}panel-${id}`;
  // The persisted view id may name a panel that no longer exists (an id from a
  // removed contribution, or a future one — both outlive a ui blob), or one
  // that is currently disabled (Changes on a card whose folder went away).
  // Either way, fall back to the first panel rather than rendering a blank
  // card with no tab highlighted and nothing to explain it.
  const active = panels.find((p) => p.id === view && panelEnabled(p, panelCtx)) ?? panels[0];

  /**
   * The tablist's arrow keys (#197). Focus moves; Enter/Space select — manual
   * activation, because arrowing past Changes must not build a Monaco diff for
   * a tab the user is only walking through (see lib/tabstrip-keys).
   *
   * The DOM is the list, exactly as the feed's navigation does it: the strip
   * already holds every tab in the order the eye reads them, and a registry of
   * our own would only be a second copy to get out of step with §5.23's
   * contributions.
   */
  const onTabKeys = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // `ownerDocument`, NOT the global `document`: a popped-out card portals this
    // whole strip into another window, whose focus the main document knows
    // nothing about. With the global, every arrow in a popout would compute
    // `current = -1` and Enter would find no tab at all — while preventDefault
    // had already eaten the button's own activation, leaving the popout's tabs
    // strictly worse off than before the tablist existed.
    const doc = e.currentTarget.ownerDocument;
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const action = tabStripAction(e.key, {
      count: tabs.length,
      current: tabs.indexOf(doc.activeElement as HTMLElement),
    });
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'focus') {
      tabs[action.index].focus();
      return;
    }
    const id = (doc.activeElement as HTMLElement | null)?.dataset.vtab;
    const p = panels.find((x) => x.id === id);
    // a "soon" tab is in the walk but has nothing to show yet
    if (p && panelEnabled(p, panelCtx)) setView(p.id);
  };

  return (
    <div
      style={{
        blockSize: '100%',
        background: 'var(--card-bg)',
        color: 'var(--muted)',
        fontSize: 11,
        position: 'relative',
        display: 'flex',
      }}
    >
      {live ? (
        <div style={{ flex: 1, minInlineSize: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {/* card header (.chead) — accent border, identity, status, window controls */}
          <div
            data-testid="card-header"
            title={t('layout.maximizeHint')}
            /* §5.8's maximize, verbatim: "double-click a session header (or one
               command) toggles maximize and restores the prior layout on
               repeat". The command is the keyboard path — hiding chrome never
               removes capability, and a double-click has none.
               Anything in the header that owns its own clicks keeps them: the
               task label is click-to-edit and the buttons act on one press, so
               a second press there is not a request to rearrange the
               workspace. Controls opt out by BEING one (a button, a field) or by
               marking themselves — the marker is what covers the click-to-edit
               task label, which is a plain span and would otherwise depend on
               React having swapped its input in between the two clicks. */
            onDoubleClick={(e) => {
              const el = e.target as HTMLElement;
              if (el.closest('button, input, textarea, select, [data-no-maximize]')) return;
              if (cardId) toggleMaximizeCard(props.containerApi, cardId);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              paddingInline: 10,
              paddingBlock: 7,
              borderBlockEnd: '1px solid var(--border)',
              borderInlineStart: `3px solid ${live.accent ?? 'var(--faint)'}`,
              background: 'var(--panel2)',
            }}
          >
            {live.badge && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  fontWeight: 700,
                  color: live.accent ?? 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  paddingInline: 4,
                  paddingBlock: 1,
                }}
              >
                {live.badge}
              </span>
            )}
            <span
              style={{
                fontWeight: 650,
                fontSize: 13,
                color: 'var(--text)',
                fontFamily: 'var(--font-ui)',
                whiteSpace: 'nowrap',
              }}
            >
              {props.api.title ?? folder}
            </span>
            {editingLabel ? (
              <input
                autoFocus
                data-no-maximize
                defaultValue={taskLabel}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  setTaskLabel(v);
                  if (cardId) void window.switchboard.sessions.setTaskLabel(cardId, v);
                  setEditingLabel(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingLabel(false);
                }}
                style={{
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                  minInlineSize: 140,
                }}
              />
            ) : (
              <span
                data-no-maximize
                onClick={() => setEditingLabel(true)}
                title={t('grid.taskLabelHint')}
                style={{
                  cursor: 'text',
                  fontSize: 11,
                  color: taskLabel ? 'var(--muted)' : 'var(--faint)',
                  fontFamily: 'var(--font-ui)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {taskLabel || t('grid.taskLabelEmpty')}
              </span>
            )}
            <span style={{ flex: 1, minInlineSize: 8 }} />
            {live.autonomy && live.autonomy !== 'ask' && (
              <span
                title={t('autonomy.title')}
                style={{
                  fontSize: 9.5,
                  fontFamily: 'var(--font-mono)',
                  // -ink, not the raw hue: this is 9.5px TEXT on --panel2, where
                  // the hue measures 3.1:1 on daylight (#221)
                  color: live.autonomy === 'full-auto' ? 'var(--status-crashed-ink)' : 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  paddingInline: 5,
                  paddingBlock: 1,
                }}
              >
                {t(`autonomy.${live.autonomy}`)}
              </span>
            )}
            <StatusPill status={status} label={t(`status.${status}`)} />
            {/* §5.8's ladder, one rung down (P2-E9-05). A mouse gesture for the
                thing the two bindings and the palette also do — the card gives
                its slot back and becomes a row in the collapsed strip, still
                running, one click from coming straight back here. */}
            <button
              data-testid="card-collapse"
              onClick={() => cardId && setCardLadder(props.containerApi, cardId, 'collapsed')}
              title={t('ladder.collapse')}
              aria-label={t('ladder.collapse')}
              style={cheadBtn}
            >
              {t('ladder.collapseIcon')}
            </button>
            <button onClick={popOutToggle} title={poppedOut ? t('grid.dockIn') : t('grid.popOut')} style={cheadBtn}>
              {poppedOut ? t('grid.dockInIcon') : t('grid.popOutIcon')}
            </button>
            <span
              style={{ position: 'relative' }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setMenuOpen(false);
                  setConfirmClear(false);
                }
              }}
            >
              <button
                title={t('grid.menu')}
                onClick={() => {
                  setMenuOpen((o) => !o);
                  setConfirmClear(false);
                }}
                style={cheadBtn}
              >
                {t('grid.menuIcon')}
              </button>
              {menuOpen && (
                <>
                  {/* click-away closes; sits under the menu itself */}
                  <div
                    onClick={() => setMenuOpen(false)}
                    style={{ position: 'fixed', inset: 0, zIndex: 30 }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      insetBlockStart: '100%',
                      insetInlineEnd: 0,
                      marginBlockStart: 4,
                      zIndex: 31,
                      minInlineSize: 200,
                      background: 'var(--panel)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      boxShadow: 'var(--tab-lift)',
                      padding: 4,
                      fontSize: 11,
                      fontFamily: 'var(--font-ui)',
                    }}
                  >
                    {/* session controls write the REAL slash command to the
                        PTY. Locked while 'starting' — the CLI may still be in
                        a startup TUI dialog the composer can't see (§5.10
                        startup-dialog rule) — and once the session is dead
                        (crashed/exited): the write would be a silent no-op.
                        'done' stays live — the session is idle, not gone. */}
                    {confirmClear && !controlsLocked ? (
                      <div style={{ padding: '4px 8px' }}>
                        <div style={{ color: 'var(--text)', marginBlockEnd: 6 }}>
                          {t('grid.menuClearConfirm')}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => {
                              writePromptToPty(live.id, '/clear');
                              setMenuOpen(false);
                              setConfirmClear(false);
                            }}
                            style={menuConfirmBtn(true)}
                          >
                            {t('grid.menuClearGo')}
                          </button>
                          <button onClick={() => setConfirmClear(false)} style={menuConfirmBtn(false)}>
                            {t('grid.menuClearCancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={toggleTransport}
                          title={t('grid.menuTransportHint')}
                          style={menuItemStyle(false)}
                        >
                          {/* State and ACTION stated separately. The first
                              version showed only the current mode — and in a
                              menu, entries read as commands, so "Transport:
                              Terminal" looked like "switch to Terminal". I
                              misread my own control while helping Dan test it
                              (#153). */}
                          {t('grid.menuTransportSwitch', {
                            now: t(
                              cardTransport === 'stream'
                                ? 'grid.transportStream'
                                : 'grid.transportPty'
                            ),
                            next: t(
                              cardTransport === 'stream'
                                ? 'grid.transportPty'
                                : 'grid.transportStream'
                            ),
                          })}
                        </button>
                        {transportPending && (
                          <div style={{ padding: '2px 8px 6px' }}>
                            <div style={{ color: 'var(--muted)', fontSize: 10, marginBlockEnd: 4 }}>
                              {t('grid.menuTransportPending')}
                            </div>
                            {/* Without this the setting could NEVER take
                                effect: the only other route to a restart is the
                                card's ✕, which DELETES the card record and the
                                stored choice with it (#153). */}
                            <button
                              onClick={() => {
                                setMenuOpen(false);
                                setTransportPending(false);
                                restartSelf();
                              }}
                              style={menuConfirmBtn(true)}
                            >
                              {t('grid.menuTransportRestart')}
                            </button>
                          </div>
                        )}
                        <button
                          disabled={controlsLocked}
                          title={
                            !controlsLocked
                              ? t('grid.menuClearHint')
                              : status === 'starting'
                                ? t('grid.menuStarting')
                                : t('grid.menuDead')
                          }
                          onClick={() => setConfirmClear(true)}
                          style={menuItemStyle(controlsLocked)}
                        >
                          {t('grid.menuClear')}
                        </button>
                        <button
                          disabled={controlsLocked}
                          title={
                            !controlsLocked
                              ? t('grid.menuCompactHint')
                              : status === 'starting'
                                ? t('grid.menuStarting')
                                : t('grid.menuDead')
                          }
                          onClick={() => {
                            writePromptToPty(live.id, '/compact');
                            setMenuOpen(false);
                          }}
                          style={menuItemStyle(controlsLocked)}
                        >
                          {t('grid.menuCompact')}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </span>
          </div>
          {/* view tabs (.vtabs). Order/default per DESIGN §5.10: Feed is the
              first tab and the eventual default view — it's a "soon" placeholder
              until the Feed renderer lands (E12), so Terminal is the interim
              default. Terminal + Diff are live today. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 3,
              paddingInline: 8,
              paddingBlock: 0,
              paddingBlockStart: 5,
              borderBlockEnd: '1px solid var(--border)',
              background: 'var(--panel2)',
            }}
          >

            {/* A REAL tablist (#197). Only the tabs are inside it — the plan
                counter, the git chip and the usage strip share the strip's row
                but are readouts, and a tablist that contained them would be
                telling a screen reader they are tabs. */}
            <div
              role="tablist"
              // dockview publishes a `tablist` of its own for the session cards,
              // so "the tab strip" is ambiguous to a role query — the testid is
              // how a spec names THIS one
              data-testid="view-tabs"
              aria-label={t('grid.viewTabs')}
              onKeyDown={onTabKeys}
              // the strip's own focus bookkeeping: the roving stop follows
              // whichever tab the arrows put focus on, and goes back to the
              // selected one the moment focus leaves the strip entirely
              onFocus={(e) => setTabFocus((e.target as HTMLElement).dataset.vtab ?? null)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTabFocus(null);
              }}
              // a flex item does not shrink below its content unless told to;
              // without this the tabs would push the git chip and the usage
              // strip off a narrow card instead of crowding as they used to
              style={{ display: 'flex', alignItems: 'flex-end', gap: 3, minInlineSize: 0 }}
            >
              {panels.map((p) => {
                const on = panelEnabled(p, panelCtx);
                const badge = panelBadge(p, panelCtx);
                const selected = active?.id === p.id;
                // a disabled panel still SHOWS — §5.8: you can always see what
                // exists, even when it isn't ready. It stays a tab, and stays in
                // the arrow-key walk, with `aria-disabled` rather than the
                // `disabled` attribute: the whole point is that you can find out
                // it exists, and `disabled` would take it out of the strip.
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    id={tabId(p.id)}
                    data-vtab={p.id}
                    aria-selected={selected}
                    aria-disabled={on ? undefined : true}
                    // only tabs whose panel is actually in the DOM point at one:
                    // a keepMounted panel is always there (merely hidden), the
                    // rest mount only while selected, and an `aria-controls`
                    // naming an element that does not exist is a dead end
                    aria-controls={selected || p.keepMounted ? tabPanelId(p.id) : undefined}
                    // The roving tab stop a tablist owes: one Tab reaches the
                    // strip, arrows move inside it. It follows FOCUS, not
                    // selection — with manual activation the two come apart the
                    // moment you arrow anywhere, and a stop left behind on the
                    // selected tab would lose your place on the way back in.
                    tabIndex={(tabFocus ?? active?.id) === p.id ? 0 : -1}
                    title={on ? undefined : t('grid.viewSoon')}
                    style={vtabStyle(selected, !on, live.accent)}
                    onClick={() => on && setView(p.id)}
                  >
                    {t(p.titleKey)}
                    {badge !== null && (
                      <span style={{ color: 'var(--status-needs-input-ink)', marginInlineStart: 4 }}>{badge}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <span style={{ flex: 1, minInlineSize: 8 }} />
            {plan && (
              <span
                title={t('grid.planTitle')}
                style={{ color: 'var(--status-working-ink)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
              >
                {t('grid.plan', { done: plan.completed, total: plan.total })}
              </span>
            )}
            <GitContext status={git} />
            {usage && <UsageStrip usage={usage.usage} model={usage.model} inline />}
          </div>
          {/* active view */}
          <div style={{ flex: 1, minBlockSize: 0, position: 'relative' }}>
            {panels.map((p) =>
              // keepMounted panels stay in the tree and hide (the terminal
              // would lose its xterm view otherwise); everything else mounts
              // only while it is the active tab
              // a contributed panel that throws must cost that panel, not the
              // window — there is no other error boundary in the renderer
              p.keepMounted ? (
                <div
                  key={p.id}
                  role="tabpanel"
                  id={tabPanelId(p.id)}
                  aria-labelledby={tabId(p.id)}
                  style={{ blockSize: '100%', display: active?.id === p.id ? 'block' : 'none' }}
                >
                  <ContributionBoundary id={p.manifest.id}>
                    {p.render({ ...panelCtx, visible: visible && active?.id === p.id })}
                  </ContributionBoundary>
                </div>
              ) : active?.id === p.id ? (
                // the mounted-only panels get the same wrapper, so the tab that
                // named it has something to name (a ContributionBoundary is not
                // an element and cannot carry the role)
                <div
                  key={p.id}
                  role="tabpanel"
                  id={tabPanelId(p.id)}
                  aria-labelledby={tabId(p.id)}
                  style={{ blockSize: '100%' }}
                >
                  <ContributionBoundary id={p.manifest.id}>
                    {p.render({ ...panelCtx, visible })}
                  </ContributionBoundary>
                </div>
              ) : null
            )}
            {exitedOverlay && <div style={overlayBackdrop}>{exitedOverlay}</div>}
          </div>
        </div>
      ) : suspended ? (
        <div style={{ ...overlayBackdrop, position: 'relative', flex: 1 }}>{suspendedOverlay}</div>
      ) : exited ? (
        // spawn/resume failed before a terminal existed — still recoverable
        <div style={{ ...overlayBackdrop, position: 'relative', flex: 1 }}>{exitedOverlay}</div>
      ) : (
        <span style={{ margin: 'auto' }}>
          {t('grid.resuming', { title: props.api.title ?? folder ?? '' })}
        </span>
      )}
    </div>
  );
}

// The active theme, read off <html> — a dockview panel is mounted outside this
// component's props, so the document is the one place both can see (P2-E15-05
// puts the id and the light/dark verdict there beside the base preset).
//
// KNOWN AND UNCHANGED BY P2-E15-05: this is a read, not a subscription, so an
// in-card Changes tab keeps the value it last rendered with until something
// else re-renders that card. The standalone Changes TAB is corrected on every
// switch (the colorScheme effect below); the in-card one would need the active
// theme to live somewhere a panel can subscribe to, which is a state-layer
// change rather than a theming one. In practice Monaco's theme is process-
// GLOBAL, so an in-card editor often follows anyway the moment any diff editor
// is re-created — that is luck, not a guarantee, and it is why this is written
// down rather than relied on.
function docTheme(): { theme: string; colorScheme: 'light' | 'dark' } {
  const d = document.documentElement.dataset;
  return {
    theme: d.themeId ?? d.theme ?? 'nordic',
    colorScheme: d.colorScheme === 'light' ? 'light' : 'dark',
  };
}

const cheadBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
  padding: '2px 4px',
};

// ⋯ session-controls menu (E10-07)
function menuItemStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'block',
    inlineSize: '100%',
    textAlign: 'start',
    background: 'transparent',
    border: 'none',
    borderRadius: 5,
    padding: '5px 8px',
    fontSize: 11,
    fontFamily: 'var(--font-ui)',
    color: disabled ? 'var(--faint)' : 'var(--text)',
    cursor: disabled ? 'default' : 'pointer',
  };
}
function menuConfirmBtn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? 'var(--btn-primary-bg)' : 'var(--panel)',
    color: primary ? 'var(--btn-primary-text)' : 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '3px 10px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 11,
  };
}

function vtabStyle(active: boolean, disabled: boolean, accent?: string): React.CSSProperties {
  const edge = accent ?? 'var(--status-working)';
  // The active tab has to read clearly at a glance across 7–8 cards: an accent
  // top stripe, an elevated (card-colored) fill that seams into the view below,
  // bolder text, and a lift shadow — inactive/soon tabs stay flat and muted.
  return {
    padding: active ? '5px 12px 7px' : '4px 11px 6px',
    borderStartStartRadius: 6,
    borderStartEndRadius: 6,
    fontSize: 11,
    fontFamily: 'var(--font-ui)',
    fontWeight: active ? 650 : 500,
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? 'var(--faint)' : active ? 'var(--text)' : 'var(--muted)',
    background: active ? 'var(--card-bg)' : 'transparent',
    borderInline: active ? '1px solid var(--border)' : '1px solid transparent',
    borderBlockStart: active ? `2px solid ${edge}` : '2px solid transparent',
    borderBlockEnd: active ? '1px solid var(--card-bg)' : '1px solid transparent',
    marginBlockEnd: active ? -1 : 0, // overlap the strip's bottom border to "connect"
    boxShadow: active ? 'var(--tab-lift)' : 'none',
    opacity: disabled ? 0.5 : 1,
  };
}

const overlayBackdrop: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'color-mix(in srgb, var(--bg) 82%, transparent)',
  display: 'grid',
  placeItems: 'center',
  textAlign: 'center',
};

function overlayBtn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? 'var(--btn-primary-bg)' : 'var(--panel)',
    color: primary ? 'var(--btn-primary-text)' : 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '4px 14px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 12,
  };
}

function DiffPanel(
  props: IDockviewPanelProps<{ folder?: string; colorScheme?: string }>
): React.JSX.Element {
  return (
    <DiffPane
      folder={props.params?.folder ?? ''}
      colorScheme={props.params?.colorScheme === 'light' ? 'light' : 'dark'}
    />
  );
}

const components = { sessionCard: SessionCardPanel, diffPane: DiffPanel };

/** Our dockview theme (#84) — one definition, applied at ready and on switch. */
function dockviewTheme(colorScheme: 'light' | 'dark'): DockviewTheme {
  return {
    name: 'switchboard',
    className: 'dockview-theme-switchboard',
    colorScheme,
    tabGroupIndicator: 'none',
  };
}

// live-id mapping, allow-all, dock-back and per-card presentation all live in
// the store now (P2-E15-07, P2-E15-08) — see store/session-store.ts.

/**
 * Pop a card out to its own OS window, or dock it back in.
 *
 * Takes the container api and a card id rather than a mounted panel's props:
 * commands and layout modes drive cards that may not be mounted, and there
 * must be exactly ONE implementation of the toggle — the two dock-back
 * semantics below are subtle enough without a second copy.
 */
export function popOutCardPanel(api: DockviewApi | null, cardId: string): void {
  const panel = api?.getPanel(`session-${cardId}`);
  if (!api || !panel) return;
  const loc = panel.api.location;
  if (loc.type === 'popout') {
    const w = loc.getWindow();
    // only arm the "stay alive" flag when a window actually exists to close —
    // else a stale flag would later mis-classify a genuine user close as a
    // toggle and skip the suspend (E8-04 review).
    if (w) sessionStore.markDockingBack(cardId);
    w?.close();
    return;
  }
  sessionStore.takeDockingBack(cardId); // drop any stale toggle flag
  // same-origin popout.html; the terminal keeps running because its JS stays
  // in this window while its DOM is adopted into the new OS window (E8)
  const popoutUrl = new URL('popout.html', window.location.href).toString();
  void api.addPopoutGroup(panel, { popoutUrl });
}

/** The popout window's rect on screen, when this panel is in one. */
function popoutBoxOf(panel: IDockviewPanel): Box | null {
  const loc = panel.api.location;
  if (loc.type !== 'popout') return null;
  const w = loc.getWindow();
  if (!w) return null;
  return { left: w.screenX, top: w.screenY, width: w.outerWidth, height: w.outerHeight };
}

/**
 * Remember where every session card currently sits (P2-E15-08).
 *
 * Runs on layout change beside the layout save, for the same reason: dockview
 * knows a card's slot only while its panel exists, and a hidden card's panel
 * does not. Writes that change nothing are dropped by the store, so this is
 * cheap despite firing on every drag frame's settle.
 */
function captureSlots(api: DockviewApi): void {
  // Never during teardown: quit removes panels one at a time, so the survivors'
  // index inside a shrinking group keeps changing and we would persist that
  // churn as the LAST write before exit. Same guard as its two neighbours.
  if (sessionStore.isTearingDown()) return;
  for (const panel of api.panels) {
    const m = /^session-(.+)$/.exec(panel.id);
    if (!m) continue;
    // A TABBED card's panel is in the shared stack, which is not where it came
    // from (P2-E9-05). Recording that as its slot would overwrite home with the
    // stack on the very next layout change — and then stepping back up would
    // "restore" it to where it already is, permanently. Its remembered slot is
    // the one captured on the way in; only a card that is actually AT its slot
    // may write one.
    if (!slotIsLive(sessionStore.getPresentation(m[1]).ladder)) continue;
    const slot = captureSlot(panel, popoutBoxOf(panel));
    if (slot) sessionStore.setPresentation(m[1], { slot });
  }
}

/**
 * The dockview group holding the tabbed cards, or null when there isn't one yet.
 *
 * Found by asking the store which OTHER cards are tabbed and looking up their
 * panels, rather than by keeping a group id of our own: dockview mints group
 * ids and round-trips them through the layout JSON, so a stack that survives a
 * relaunch is found again for free, and there is no second record of "which
 * group is the stack" to fall out of date.
 *
 * Popped-out groups are skipped — a card sent to the tab stack should join the
 * cards in the main window, not get swept into somebody's second monitor.
 */
function tabStackGroup(api: DockviewApi, exceptCardId: string): DockviewApi['groups'][number] | null {
  for (const [cardId, p] of sessionStore.getState().presentation) {
    if (cardId === exceptCardId || p.ladder !== 'tabbed') continue;
    const panel = api.getPanel(`session-${cardId}`);
    if (panel && panel.group.api.location.type === 'grid') return panel.group;
  }
  return null;
}

// ── §5.8's presentation ladder (P2-E9-05) ───────────────────────────────────
//
// ONE verb drives all four rungs, and that is the point: E9-06's presentation
// policy and E9-07's layout modes both need to put a NAMED session on a NAMED
// rung from outside the card, so a layout mode is nothing but a map of
// card -> rung applied through setCardLadder, not a fourth way to rearrange
// the workspace.
//
// The dockview work each rung needs falls out of the two questions lib/ladder
// answers — does the rung have a panel, and is the card's slot its home:
//
//   expanded   panel, at its own slot          -> place it back at the slot
//   collapsed  no panel, a row in the strip    -> capture slot, remove panel
//   tabbed     panel, in the SHARED tab stack  -> capture slot, then move it
//   hidden     no panel, no row                -> capture slot, remove panel
//
// None of them ends anything: the session runs on in the main process, the
// record survives, and the rail, the lamp and the Events list still list it.
// That is the whole difference between the bottom rung and a close.
//
// Module functions on (api, cardId), like popOutCardPanel above and for the
// same reason — commands, the card header and layout modes all drive cards
// that may not be mounted, and a second copy of these rules is how the ladder
// starts disagreeing with itself.

/**
 * Transitions in flight, by card id.
 *
 * A re-entrancy guard, not app state — which is why it is allowed in module
 * scope after P2-E15-07 moved the app's state into the store. Every transition
 * below has an `await` in it, and the panel-exists check happens BEFORE that
 * await: two clicks inside one `sessions:cards` round-trip would both get past
 * it and the second would hit dockview's duplicate-panel-id throw, an uncaught
 * rejection on an ordinary double-click.
 */
const laddering = new Set<string>();

/** Take a card's panel out of the workspace, remembering where it was. Shared
 *  by the two panel-less rungs, which differ only in what is left behind. */
function removePanelKeepingSlot(api: DockviewApi, cardId: string, rung: Ladder): void {
  const panel = api.getPanel(`session-${cardId}`);
  sessionStore.setPresentation(cardId, {
    ladder: rung,
    // a card already in the tab stack is NOT at its home slot, so re-reading
    // dockview would record the stack as home and strand it there
    ...(panel && slotIsLive(sessionStore.getPresentation(cardId).ladder)
      ? { slot: captureSlot(panel, popoutBoxOf(panel)) }
      : {}),
    // a card with no panel is in no window; poppedOut reflects dockview's truth
    // and must not keep asserting one that no longer exists
    poppedOut: false,
  });
  if (!panel) return;
  // dockview cannot tell our removal from the user closing the tab, and the two
  // mean opposite things — the flag is how onDidRemovePanel (and the popout
  // location handler) tell them apart
  sessionStore.setHiding(cardId, true);
  try {
    api.removePanel(panel);
  } finally {
    sessionStore.setHiding(cardId, false);
  }
}

/**
 * §5.8's auto-minimize on submit (P2-E9-06).
 *
 * The user just sent a prompt; the presentation policy says whether that card
 * keeps the screen. Every rule about WHETHER to move is in `submitTarget`
 * (pure, unit-tested); this function is only the dockview half.
 *
 * IT READS THE CARD AS IT IS NOW, which is why the caller defers the CALL and
 * not the decision: three of the four rules describe the card at the moment we
 * would move it, so a card popped out (or blocked) between the keystroke and
 * this call must still be spared.
 */
export function applySubmitPolicy(api: DockviewApi | null, cardId: string): void {
  if (!api || !cardId || sessionStore.isTearingDown()) return;
  const p = sessionStore.getPresentation(cardId);
  const rung = submitTarget({
    policy: sessionStore.policyFor(cardId),
    ladder: p.ladder,
    poppedOut: p.poppedOut,
    // the same vocabulary the rail rows and the lamps use, so "waiting on a
    // human" cannot mean one thing here and another three feet to the left
    needsHuman: presentStatus(
      sessionStore.getState().sessions.find((s) => s.id === cardId)?.status
    ).needsYou,
  });
  if (rung) setCardLadder(api, cardId, rung);
}

/**
 * Put a card on a named rung, and RESOLVE WHEN IT IS THERE.
 *
 * The awaitable form exists for E9-07's layout sweep, which moves several cards
 * in one pass: a card comes home to the dock slot it remembers, so two
 * transitions running at once read that slot's group while the other is still
 * creating (or destroying) it. `setCardLadder` below is the fire-and-forget
 * entry point every single-card caller uses — one implementation, two doors.
 *
 * `focus` is false for a sweep: §5.8 makes showing and focusing two different
 * questions, and a layout mode moving cards around must not also decide where
 * the user is looking.
 */
export function moveCardToRung(
  api: DockviewApi,
  cardId: string,
  rung: Ladder,
  focus: boolean
): Promise<void> {
  // A transition for this card is already in flight. Without this, a collapse
  // issued while a reveal is awaiting `sessions.cards()` would write its rung,
  // find no panel, return — and then the in-flight reveal would add the panel
  // and write `expanded` on top, silently discarding the user's command.
  if (laddering.has(cardId)) return Promise.resolve();
  if (sessionStore.getPresentation(cardId).ladder === rung) return Promise.resolve(); // already there
  if (rung === 'expanded') return revealCardPanel(api, cardId, focus);
  if (rung === 'tabbed') return toTabbed(api, cardId);
  removePanelKeepingSlot(api, cardId, rung);
  return Promise.resolve();
}

/** Put a card on a named rung. Safe on a card with no panel — that is the point. */
export function setCardLadder(api: DockviewApi | null, cardId: string, rung: Ladder): void {
  if (!api || !cardId) return;
  void moveCardToRung(api, cardId, rung, true);
}

/**
 * Step a card one rung down (collapse) or up (expand).
 *
 * The current rung is read HERE rather than in the command, which keeps
 * lib/command-set free of presentation state: it knows what the app can do, not
 * what the app is currently doing.
 */
export function stepCardLadder(
  api: DockviewApi | null,
  cardId: string,
  dir: 'down' | 'up'
): void {
  if (!api || !cardId) return;
  const cur = sessionStore.getPresentation(cardId).ladder;
  setCardLadder(api, cardId, dir === 'down' ? stepDown(cur) : stepUp(cur));
}

// ── §5.8's layout modes (P2-E9-07) ──────────────────────────────────────────
//
// A mode is a map of card -> rung applied through `setCardLadder`, exactly as
// the ladder's header promised: there is no second layout engine here, and a
// rung a mode put a card on is the same rung the palette puts it on. Every RULE
// is in lib/layout-mode (pure, unit-tested); this is the dockview half.

/**
 * The cards a plan is computed over — rail order, current rung, and the two
 * facts that exempt a card from being folded away.
 *
 * RAIL ORDER and not the panel list, for the reason the collapsed strip and the
 * lamps use it: it is the numbering authority for Ctrl+1..9, and a card that is
 * third in one list and first in another is how two surfaces disagree. It also
 * includes cards with NO PANEL, which is the whole point — a mode has to be
 * able to bring a hidden session back.
 */
function layoutCards(): LayoutCard[] {
  return sessionStore.getRailOrder().flat.map((s) => {
    const p = sessionStore.getPresentation(s.id);
    return {
      cardId: s.id,
      ladder: p.ladder,
      // the same vocabulary the rail rows, the lamps and the submit policy use
      needsAttention: presentStatus(s.status).needsYou,
      poppedOut: p.poppedOut,
    };
  });
}

/**
 * One sweep — the dockview grid it moves cards in, carried on the request.
 *
 * lib/layout-sweep owns the machine (one sweep at a time, at most one queued,
 * moves in order, abort on teardown) and knows nothing about dockview, which is
 * how that machine gets unit tests instead of only e2e ones. The api rides
 * along rather than being read from module scope so a drained sweep provably
 * runs against the grid it was asked for.
 */
interface LayoutSweep extends SweepRequest {
  api: DockviewApi;
}

/**
 * Has the grid finished coming up?
 *
 * A boot restore replays the arrangement the user quit with, rung by rung
 * (E15-08 persists them), and most of it is `await`ed — so `isRestoringLayout`,
 * which only spans the synchronous `fromJSON`, is not enough of a fence. A
 * sweep landing inside that window would race `addPanel` against panels the
 * restore is still placing. Nothing may sweep until the restore is done, and
 * onReady sweeps ONCE at the end so a restored mode is applied deterministically
 * rather than whenever the first session refresh happens to arrive.
 */
let gridReady = false;

/**
 * The dockview half of the sweep: every effect lib/layout-sweep is not allowed
 * to know about, in one object.
 *
 * Exported for `SessionGrid.test.tsx`, which asserts the two halves are wired
 * to each other correctly — that `needed` really is "grid is not enforced on a
 * reactive pass" and that `plan` really is computed over the rail order — none
 * of which is reachable through `applyLayout` without a live grid.
 */
export const layoutSweepPort: SweepPort<LayoutSweep> = {
  // `gridReady` is the fence a boot restore needs; the other two are the
  // teardown and restore windows dockview must not be touched in.
  ready: () => gridReady && !sessionStore.isTearingDown() && !sessionStore.isRestoringLayout(),

  // The cheap early-out, before building the card list. GRID IS NOT ENFORCED ON
  // `react` (lib/layout-mode's `LayoutTrigger` says why); an un-maximize always
  // has work, because its whole payload is work.
  needed: (req) => req.trigger !== 'react' || !!req.restore || isEnforced(sessionStore.getLayout()),

  plan: (req) =>
    layoutPlan({
      state: sessionStore.getLayout(),
      cards: layoutCards(),
      activeCardId: sessionStore.getState().activeCard,
      trigger: req.trigger,
      ...(req.restore ? { restore: req.restore } : {}),
    }),

  // WITHOUT FOCUS: `focus` mode moves the big card to whatever you are already
  // in, so grabbing focus would be the layout telling the user where to look.
  // Single-card commands focus, because there the move IS the gesture.
  applyMove: (move, req) => moveCardToRung(req.api, move.cardId, move.rung, false),

  aborted: () => sessionStore.isTearingDown(),

  onError: (err) => console.error('[layout] sweep failed', err),
};

const layoutSweeper = createSweeper(layoutSweepPort);

/**
 * Put every session where the current layout mode wants it.
 *
 * `restore` is the un-maximize path: the rungs to put back, exactly (see
 * lib/layout-mode's `plan`).
 */
export function applyLayout(
  api: DockviewApi | null,
  trigger: LayoutTrigger,
  restore?: Readonly<Record<string, Ladder>>
): void {
  if (!api) return;
  // Nothing awaits a sweep: a click that changes the mode is done the moment
  // the mode is written, and the cards catch up. The promise exists for tests.
  void layoutSweeper.request({ api, trigger, ...(restore ? { restore } : {}) });
}

/** Switch the workspace to a named layout mode (§5.8). */
export function setLayoutMode(api: DockviewApi | null, mode: LayoutMode): void {
  const cur = sessionStore.getLayout();
  if (cur.mode === mode && !cur.maximized) return;
  sessionStore.setLayout(withMode(mode));
  applyLayout(api, 'switch');
}

/** Next mode in the cycle — the binding and the titlebar chip. */
export function cycleLayoutMode(api: DockviewApi | null): void {
  setLayoutMode(api, cycleMode(sessionStore.getLayout().mode));
}

/**
 * §5.8's maximize: "double-clicking a session header toggles maximize and
 * restores the prior layout on repeat".
 *
 * The restore is the SNAPSHOT taken on the way in, not a re-application of the
 * current mode — a card the user had hidden before maximizing is hidden again
 * afterwards, which is what "the prior layout" means.
 */
export function toggleMaximizeCard(api: DockviewApi | null, cardId: string): void {
  if (!api || !cardId) return;
  const cur = sessionStore.getLayout();
  if (cur.maximized === cardId) {
    const restore = cur.restore; // read BEFORE the edit forgets it
    sessionStore.setLayout(withoutMaximized(cur));
    applyLayout(api, 'switch', restore);
    return;
  }
  sessionStore.setLayout(withMaximized(cur, cardId, snapshotRungs(layoutCards())));
  applyLayout(api, 'switch');
}

/**
 * Bring a card back to `expanded`, in exactly the slot it left.
 *
 * `focus` is false for an ATTENTION reveal. §5.8 makes reveal and focus two
 * different questions — whether a session that needs you may grab the screen is
 * the focus-stealing policy's call (E9-10: `smart`, the default, is "focus if
 * its card is visible, else mark urgent"), and a blocked session yanking the
 * cursor out of the card you are typing in is precisely what that setting
 * exists to prevent. Reveal puts it back where you can see it; the lamp and the
 * queue are what say it wants you.
 */
export async function revealCardPanel(
  api: DockviewApi | null,
  cardId: string,
  focus = true
): Promise<void> {
  if (!api || laddering.has(cardId)) return;
  const existing = api.getPanel(`session-${cardId}`);
  if (existing && sessionStore.getPresentation(cardId).ladder !== 'tabbed') {
    // A MOUNTED PANEL IS IN THE WORKSPACE, so heal the rung on the way past.
    // SessionCardPanel's mount effect says the same thing, but dockview's
    // default renderer only mounts a panel when it becomes visible — an
    // inactive restored tab whose blob says `collapsed` would otherwise show as
    // BOTH a tab and a strip row until somebody clicked it.
    sessionStore.setPresentation(cardId, { ladder: 'expanded' });
    if (focus) existing.focus(); // already in the workspace: reveal means "show me"
    return;
  }
  laddering.add(cardId);
  try {
    // A TABBED card is a panel too, buried in the shared stack — expanding it
    // has to move it home, not merely select its tab, or the ladder would have
    // a rung with no way back up.
    if (existing) await moveHome(api, cardId, existing, focus);
    else await revealNow(api, cardId, focus);
  } finally {
    laddering.delete(cardId);
  }
}

/**
 * Move a card into the SHARED tab stack (§5.8's third rung).
 *
 * All tabbed cards share one dockview group, so together they cost one slot and
 * only the selected one is on screen — dockview's own tab group IS i3's tabbed
 * layout, so this rung is a move rather than a new widget. The stack is found
 * by looking for another tabbed card's group (tabStackGroup), so it survives a
 * relaunch for free and there is no "which group is the stack" record of our
 * own to keep true.
 *
 * A card with no panel (collapsed or hidden) is placed back first: you cannot
 * move what is not there, and stepping UP from hidden to tabbed has to arrive
 * somewhere.
 */
async function toTabbed(api: DockviewApi, cardId: string): Promise<void> {
  if (laddering.has(cardId)) return;
  laddering.add(cardId);
  try {
    let panel = api.getPanel(`session-${cardId}`);
    if (!panel) {
      // land it at home first: that establishes the slot the stack has to give
      // back later, and reuses the one reveal path rather than a second copy
      await revealNow(api, cardId, false);
      panel = api.getPanel(`session-${cardId}`);
      if (!panel) return; // record gone mid-flight — revealNow already bailed
    }
    // capture home BEFORE the move, and only while the card still is at home
    const cur = sessionStore.getPresentation(cardId);
    const slot = slotIsLive(cur.ladder) ? captureSlot(panel, popoutBoxOf(panel)) : cur.slot;
    const stack = tabStackGroup(api, cardId);
    if (stack && stack !== panel.group) {
      // OUR move, not a user drag — see setMoving. Without the flag this would
      // adopt the stack-mate's persistent group as this session's own.
      sessionStore.setMoving(cardId, true);
      try {
        panel.api.moveTo({ group: stack });
      } catch {
        // a stack that vanished between the lookup and the move: the card stays
        // where it is and still counts as tabbed. The wrong group beats an
        // uncaught rejection on a layout command.
      } finally {
        sessionStore.setMoving(cardId, false);
      }
    }
    sessionStore.setPresentation(cardId, { ladder: 'tabbed', slot, poppedOut: false });
  } finally {
    laddering.delete(cardId);
  }
}

/** Put a card that HAS a panel back at its home slot, and mark it expanded. */
async function moveHome(
  api: DockviewApi,
  cardId: string,
  panel: IDockviewPanel,
  focus: boolean
): Promise<void> {
  const place = placeAt(
    sessionStore.getPresentation(cardId).slot,
    api.groups.map((g) => g.id)
  );
  const home = place.groupId ? api.groups.find((g) => g.id === place.groupId) : undefined;
  // Is the card's remembered home the tab stack itself? It is for the card that
  // SEEDED the stack: the first card tabbed finds no stack to join, stays put,
  // and records the group it is standing in as home. Expanding it would then
  // find home == its current group, move nothing, and leave it stacked with the
  // tabbed cards while claiming to be expanded — the rung as a lie, which is
  // exactly what the fresh-group branch below exists to prevent.
  const homeIsStack =
    !!home &&
    home.panels.some((p) => {
      const m = /^session-(.+)$/.exec(p.id);
      return !!m && m[1] !== cardId && sessionStore.getPresentation(m[1]).ladder === 'tabbed';
    });
  const target = homeIsStack ? undefined : home;
  // OUR move, not a user drag — see setMoving. The fresh-group branch is the
  // one that MUST be flagged: a group with no siblings adopts `null`, which
  // would erase the session's persistent group outright.
  sessionStore.setMoving(cardId, true);
  try {
    if (target && target !== panel.group) {
      try {
        panel.api.moveTo({
          group: target,
          ...(place.index >= 0 ? { index: place.index } : {}),
          skipSetActive: !focus,
        });
      } catch {
        // fewer tabs than there were: the right group at the wrong index beats
        // refusing to come back (the same call revealNow makes)
      }
    } else if (!target) {
      // Home is gone, was never recorded, or IS the stack. Give it a group of
      // its own in the grid rather than leaving it where it is.
      //
      // A popout home is NOT re-opened here, unlike revealNow's placement: a
      // tabbed card is by definition sitting in the main window's stack, and
      // having a rung change spawn an OS window is a bigger surprise than
      // landing in the grid. The slot record is untouched, so the monitor is
      // still what a later hide-and-click restores.
      try {
        panel.api.moveTo({ group: api.addGroup(), skipSetActive: !focus });
      } catch {
        /* fail-open: it stays in the stack, still marked expanded */
      }
    }
  } finally {
    sessionStore.setMoving(cardId, false);
  }
  // Home may BE the group it is already in — a card tabbed while it was already
  // sharing a group with neighbours that are NOT tabbed. Then the rung change is
  // the whole transition, which is why both branches above can be skipped.
  sessionStore.setPresentation(cardId, { ladder: 'expanded' });
  if (focus) panel.focus();
}

/** Create a card's panel at its remembered slot (or monitor). */
async function revealNow(api: DockviewApi, cardId: string, focus = true): Promise<void> {
  const card = (await window.switchboard.sessions.cards()).find((c) => c.cardId === cardId);
  if (!card) return; // the record is gone — there is nothing to reveal
  const place = placeAt(
    sessionStore.getPresentation(cardId).slot,
    api.groups.map((g) => g.id)
  );
  const target = place.groupId ? api.groups.find((g) => g.id === place.groupId) : undefined;
  // its old group may have died with it (removing a group's last panel destroys
  // the group) — land it in the grid rather than nowhere
  const refGroup =
    target ?? api.groups.find((g) => g.api.location.type === 'grid') ?? api.addGroup();
  const panel = api.addPanel({
    id: `session-${cardId}`,
    component: 'sessionCard',
    title: card.title,
    params: {
      cardId,
      folder: card.folder,
      title: card.title,
      groupId: card.groupId,
    } satisfies CardParams,
    position: { referenceGroup: refGroup },
    // dockview activates a newly added panel by default, which for an ATTENTION
    // reveal is precisely the focus steal this path exists to avoid: the card
    // has to come back visible WITHOUT pulling the tab out from under whatever
    // the user is typing in. `focus` is the caller's answer to that question.
    inactive: !focus,
  });
  if (target && place.index >= 0) {
    // OUR move (see setMoving). addPanel above carries the card's own groupId
    // in its params, so the create path is already right; this reposition would
    // otherwise adopt whatever the slot's neighbours belong to.
    sessionStore.setMoving(cardId, true);
    try {
      // skipSetActive for the same reason as `inactive` above: the move must
      // not undo the very thing that flag just bought
      panel.api.moveTo({ group: target, index: place.index, skipSetActive: !focus });
    } catch {
      // the group has fewer tabs than it did; being in the right group at the
      // wrong index beats refusing to come back
    } finally {
      sessionStore.setMoving(cardId, false);
    }
  }
  sessionStore.setPresentation(cardId, { ladder: 'expanded' });
  if (place.popout) {
    // It was in its own window and that window is gone: open a new one at the
    // remembered rect, opener-relative (#86). The rect is absolute screen
    // coordinates from a previous session, so it gets the same display check a
    // restored layout gets (E8-02) — a monitor that has since been unplugged
    // must not swallow the card. No position = dockview opens it on top of the
    // main window, which is exactly the E8-02 rescue.
    const areas = await window.switchboard.workAreas();
    const onScreen = boxOnAnyDisplay(place.popout, areas as WorkArea[]);
    void api.addPopoutGroup(panel, {
      popoutUrl: new URL('popout.html', window.location.href).toString(),
      ...(onScreen ? { position: openerRelative(place.popout, window) } : {}),
    });
  } else if (focus) {
    panel.focus();
  }
}

// Grid-drag membership sync (E12-04): after a user drag drops a session panel
// into a dockview group, it adopts its new siblings' persistent group.
async function adoptMembershipFromDockGroup(
  props: IDockviewPanelProps<CardParams>
): Promise<void> {
  const cardId = props.params?.cardId;
  if (!cardId) return;
  const panel = props.containerApi.getPanel(props.api.id);
  if (!panel || panel.group.api.location.type !== 'grid') return; // popouts don't regroup
  const siblingIds = panel.group.panels
    .map((p) => /^session-(.+)$/.exec(p.id)?.[1])
    .filter((x): x is string => !!x);
  const cards = await window.switchboard.sessions.cards();
  const mine = cards.find((c) => c.cardId === cardId);
  if (!mine) return; // brand-new card, no record yet — create() carries its groupId
  const target = pickAdoptedGroupId(cardId, siblingIds, cards);
  if ((mine.groupId ?? null) !== target) {
    await window.switchboard.groups.setSessionGroup(cardId, target);
    // the rail lives in App state — tell it to re-read memberships
    sessionStore.notifyMembershipChanged();
  }
}

export interface GridController {
  /** create a session in `folder` and add its card (drag-drop, rail actions);
   *  groupId places it clustered with its persistent group (E12) */
  addSessionCard: (folder: string, groupId?: string) => Promise<void>;
  /** move an existing card's PANEL next to its persistent-group siblings
   *  after a rail drop set its membership (E12-04) */
  moveCardToGroup: (cardId: string, groupId: string | null) => void;
  /** focus an existing session's card */
  /** focus a card by card id or live session id; true if it raised ANOTHER
   *  OS window (the card was popped out) — see the popout key bridge in App */
  focusSession: (sessionId: string) => boolean;
  /** re-pop rescued popouts at their stashed positions (E8-06 accept) */
  restoreRescuedPopouts: () => void;
  /** open (or focus) the per-session diff tab (E5-02) */
  openDiff: (sessionId: string, folder: string, title: string) => void;
  /** card id of the active session panel, or null (E9-01 command context) */
  activeCardId: () => string | null;
  /** close a card the way the tab ✕ does — including its confirm (E9-01) */
  closeCard: (cardId: string) => void;
  /** switch a card's active view tab; 'terminal' toggles back to the Session
   *  view when the Terminal is already showing (E9-01) */
  toggleCardView: (cardId: string, view: PanelId) => void;
  /** pop the card out to its own window, or dock it back in (E9-01) */
  popOutCard: (cardId: string) => void;
  /** take the card out of the workspace, remembering its slot (§5.8 ladder).
   *  The session KEEPS RUNNING and the record survives — this is not a close. */
  hideCard: (cardId: string) => void;
  /** put a card back where it was (§5.8's reveal contract). `focus` is false
   *  for an ATTENTION reveal — see revealCard's own note on why showing and
   *  focusing are two questions. */
  revealCard: (cardId: string, focus?: boolean) => void;
  /**
   * Put a card on a named rung of §5.8's ladder (P2-E9-05).
   *
   * The general form of hide/reveal, and the seam E9-06's presentation policy
   * and E9-07's layout modes are meant to drive: a layout MODE is a map of card
   * -> rung applied through this, not a fourth way to rearrange the workspace.
   * Safe on a card with no panel — that is most of the point.
   */
  setLadder: (cardId: string, rung: Ladder) => void;
  /** step the card one rung down (collapse) or up (expand) — the two bindings */
  stepLadder: (cardId: string, dir: 'down' | 'up') => void;
  // ── §5.8's layout modes (P2-E9-07) ──────────────────────────────────────
  /** put the workspace in a named mode — grid · focus · queue */
  setLayoutMode: (mode: LayoutMode) => void;
  /** next mode in the cycle (the titlebar chip and the binding) */
  cycleLayoutMode: () => void;
  /** blow one session up to fill the workspace, or put the prior layout back */
  toggleMaximize: (cardId: string) => void;
  /**
   * Re-apply the mode after something moved underneath it — a session started
   * needing a human, focus changed, a card arrived. A no-op unless a mode is
   * actually holding the workspace in shape (lib/layout-mode's `isEnforced`),
   * which is what keeps the default `grid` from undoing the ladder.
   */
  applyLayout: (trigger: LayoutTrigger) => void;
}

export function SessionGrid(props: {
  /** the light/dark verdict dockview and Monaco need */
  colorScheme: 'light' | 'dark';
  seedPanels: number;
  onCardsChanged: (ids: string[]) => void;
  /** which card the grid is showing — the rail paints it as the selected row */
  onActiveCardChanged?: (cardId: string | null) => void;
  controller?: React.MutableRefObject<GridController | null>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const apiRef = useRef<DockviewApi | null>(null);
  const counter = useRef(0);

  // Add a NEW card. It gets a stable id and spawns its session lazily when it
  // becomes visible (which, as the newly-active tab, is immediately).
  const addSessionCard = useCallback(async (folder: string, groupId?: string) => {
    const api = apiRef.current;
    if (!api) return;
    const title = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder;
    const cardId = crypto.randomUUID();
    // A new session must land in the MAIN window, never as a tab inside whatever
    // popout happens to be active. dockview's addPanel defaults to the active
    // group — which becomes the popout once a card is torn off — so pin it to a
    // main-grid group explicitly (E8-04). If every card is popped out there is
    // no grid group left, so make one in the main grid rather than falling back
    // to the (popout) active group.
    // A persistent-group member clusters with its siblings (E12-02): reuse the
    // dockview group already holding another member, when one is in the grid.
    let refGroup = api.groups.find((g) => g.api.location.type === 'grid') ?? api.addGroup();
    if (groupId) {
      const cards = await window.switchboard.sessions.cards();
      const siblings = new Set(
        cards.filter((c) => c.groupId === groupId).map((c) => `session-${c.cardId}`)
      );
      const sibling = api.panels.find(
        (p) => siblings.has(p.id) && p.group.api.location.type === 'grid'
      );
      if (sibling) refGroup = sibling.group;
    }
    api.addPanel({
      id: `session-${cardId}`,
      component: 'sessionCard',
      title,
      params: { cardId, folder, title, groupId } satisfies CardParams,
      position: { referenceGroup: refGroup },
    });
  }, []);

  // §5.8's presentation ladder (P2-E9-05). The verbs are MODULE functions on
  // (api, cardId) — see setCardLadder — for the reason popOutCardPanel is one:
  // commands, the card header and E9-07's layout modes all drive cards that may
  // not be mounted, and there must be exactly one implementation. These are the
  // component's handles on them.
  const setLadder = useCallback(
    (cardId: string, rung: Ladder) => setCardLadder(apiRef.current, cardId, rung),
    []
  );
  const stepLadder = useCallback(
    (cardId: string, dir: 'down' | 'up') => stepCardLadder(apiRef.current, cardId, dir),
    []
  );
  const hideCard = useCallback((cardId: string) => setCardLadder(apiRef.current, cardId, 'hidden'), []);
  const revealCard = useCallback(
    (cardId: string, focus = true) => revealCardPanel(apiRef.current, cardId, focus),
    []
  );

  // §5.8's auto-minimize on submit (P2-E9-06). Subscribed ONCE, here, rather
  // than per card: the grid is the only thing that owns the dockview api, and a
  // subscription per mounted panel would collapse a card that had already been
  // collapsed by its neighbour's copy of the same listener.
  React.useEffect(() => {
    // DEFERRED BY A TICK, and that is not cosmetic: the notification arrives
    // from inside the composer's own submit handler, which lives in the very
    // panel we may be about to unmount. Acting synchronously would tear that
    // panel out from under React while it is still dispatching the event and
    // finishing its own state updates (clearing the draft, restoring the
    // caret). A microtask is not enough — React flushes a discrete event's
    // updates before macrotasks, not before microtasks.
    //
    // The timers are tracked so a teardown in that window cancels them rather
    // than calling into a disposed dockview api.
    const pending = new Set<ReturnType<typeof setTimeout>>();
    const off = sessionStore.subscribePromptSubmit((liveId) => {
      const cardId = sessionStore.cardIdForLive(liveId);
      const timer = setTimeout(() => {
        pending.delete(timer);
        applySubmitPolicy(apiRef.current, cardId);
      }, 0);
      pending.add(timer);
    });
    return () => {
      off();
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  React.useEffect(() => {
    if (!props.controller) return;
    props.controller.current = {
      addSessionCard,
      moveCardToGroup: (cardId, groupId) => {
        const api = apiRef.current;
        if (!api || !groupId) return; // ungrouping keeps the panel where it sits
        const panel = api.getPanel(`session-${cardId}`);
        if (!panel) return;
        void window.switchboard.sessions.cards().then((cards) => {
          const siblings = new Set(
            cards
              .filter((c) => c.groupId === groupId && c.cardId !== cardId)
              .map((c) => `session-${c.cardId}`)
          );
          const sibling = api.panels.find(
            (p) => siblings.has(p.id) && p.group.api.location.type === 'grid'
          );
          if (sibling && sibling.group !== panel.group) panel.api.moveTo({ group: sibling.group });
        });
      },
      hideCard,
      revealCard: (cardId, focus) => void revealCard(cardId, focus ?? true),
      setLadder,
      stepLadder,
      setLayoutMode: (mode) => setLayoutMode(apiRef.current, mode),
      cycleLayoutMode: () => cycleLayoutMode(apiRef.current),
      toggleMaximize: (cardId) => toggleMaximizeCard(apiRef.current, cardId),
      applyLayout: (trigger) => applyLayout(apiRef.current, trigger),
      focusSession: (liveId) => {
        const cardId = sessionStore.cardIdForLive(liveId);
        const panel = apiRef.current?.getPanel(`session-${cardId}`);
        // §5.8: "reveal triggers: ... user click anywhere (sidebar, event,
        // lamp)". Every one of those paths lands here, so a hidden card comes
        // back rather than the click doing nothing.
        if (!panel) {
          void revealCard(cardId);
          return false;
        }
        panel.focus();
        // a popped-out card is in another OS window — focusing the panel alone
        // leaves it buried behind this one, so raise its window too (E9-01)
        const loc = panel.group.api.location;
        if (loc.type !== 'popout') return false;
        loc.getWindow()?.focus();
        // tells the caller we raised a DIFFERENT window: the popout keyboard
        // bridge must not then pull the main window in front of it
        return true;
      },
      activeCardId: () => {
        const panel = apiRef.current?.activePanel;
        // a popped-out card lives in ANOTHER OS window; commands typed in this
        // one must never act on it (you'd confirm-close a card you can't see)
        if (!panel || panel.group.api.location.type !== 'grid') return null;
        const m = /^session-(.+)$/.exec(panel.id);
        return m ? m[1] : null;
      },
      closeCard: (cardId) => {
        const api = apiRef.current;
        const panel = api?.getPanel(`session-${cardId}`);
        // same contract as the tab ✕ (Dan 2026-07-22): confirm, because this
        // ends the session and forgets the record
        // store FIRST (#264): the panel's title is dockview's birth-time copy
        // and is always set, so asking it first meant a renamed session was
        // confirmed away under its old name — the record was only ever reached
        // for a HIDDEN card, which has no panel.
        const title = cardHeaderTitle(
          sessionStore.getCardTitle(cardId),
          panel?.title,
          (panel?.params as CardParams | undefined)?.folder
        );
        if (!window.confirm(t('grid.closeConfirm', { title }))) return;
        if (api && panel) {
          api.removePanel(panel); // onDidRemovePanel -> closeCard
          return;
        }
        // A HIDDEN card has no panel, and its ✕ is right there in the rail.
        // §5.8's invariant is that hiding chrome never removes capability, so
        // closing has to work on a card that isn't in the workspace — do by
        // hand exactly what onDidRemovePanel would have done.
        sessionStore.forgetCardLiveIds(cardId);
        sessionStore.forgetPresentation(cardId);
        sessionStore.forgetLayoutCard(cardId);
        void window.switchboard.sessions.closeCard(cardId);
      },
      toggleCardView: (cardId, view) => {
        // straight at the store: this used to go through a handle the card
        // registered only while LIVE, so a suspended or hidden card silently
        // ignored the command. Now the tab is set and is right when it returns.
        // toggling: a second press on the same view returns to the Session view
        const current = sessionStore.getPresentation(cardId).view;
        sessionStore.setPresentation(cardId, {
          view: current === view && view !== DEFAULT_PANEL_ID ? DEFAULT_PANEL_ID : view,
        });
      },
      popOutCard: (cardId) => popOutCardPanel(apiRef.current, cardId),
      restoreRescuedPopouts: () => {
        const api = apiRef.current;
        if (!api) return;
        const stash = uiGet<RescuedPopout[]>('rescuedPopouts', []);
        const popoutUrl = new URL('popout.html', window.location.href).toString();
        for (const r of stash) {
          for (const pid of r.panelIds) {
            const panel = api.getPanel(pid);
            if (!panel) continue; // card closed since the rescue — leave it be
            const loc = panel.group.api.location;
            if (loc.type === 'popout') {
              // the rescue reopened it near the main window (E8-02): move that
              // window back to its stashed spot on the returned display. The
              // move happens in the main process — DOM moveTo clamps to the
              // screens Chromium knew at open time.
              const win = loc.getWindow();
              if (win) {
                void window.switchboard.movePopout({ x: win.screenX, y: win.screenY }, r.box);
              }
            } else if (loc.type === 'grid') {
              // docked back since (suspend/dock-in): pop it out fresh, in place
              // dockview opens at `opener.screenX + position.left`, so hand it
              // an opener-RELATIVE box or the stashed absolute rect gets the
              // main window's origin added to it (#86)
              void api.addPopoutGroup(panel, {
                popoutUrl,
                position: {
                  left: r.box.left - window.screenX,
                  top: r.box.top - window.screenY,
                  width: r.box.width,
                  height: r.box.height,
                },
              });
            }
          }
        }
        uiSet('rescuedPopouts', []);
      },
      openDiff: (liveId, folder, title) => {
        const api = apiRef.current;
        if (!api) return;
        const cardId = sessionStore.cardIdForLive(liveId);
        const existing = api.getPanel(`diff-${cardId}`);
        if (existing) return existing.focus();
        api.addPanel({
          id: `diff-${cardId}`,
          component: 'diffPane',
          title: t('diff.tabTitle', { title }),
          params: { folder, colorScheme: props.colorScheme },
        });
      },
    };
    // eslint's exhaustive-deps plugin isn't installed; deps kept accurate by hand
  }, [props.controller, addSessionCard, hideCard, revealCard, setLadder, stepLadder, props.colorScheme, t]);

  // Dockview learns the light/dark verdict in onReady, which runs ONCE — so a
  // theme switch after mount left it on the scheme the app booted with. Every
  // dockview COLOR comes from our tokens (theme/dockview-tokens.css), so this
  // only drives its own scheme-dependent chrome, but "only cosmetic" is what
  // the last four #84 bugs were called too.
  React.useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.updateOptions({ theme: dockviewTheme(props.colorScheme) });
    // An OPEN Changes tab took its scheme as a panel PARAM when it opened, so
    // without this it keeps whatever skin it was born with through every later
    // switch. Only the LIVE case needs covering: a restore drops every diff
    // panel on purpose (see restoreLayout below), so none survives a relaunch
    // to be healed here. `updateParameters` MERGES, so this names one key.
    for (const panel of api.panels) {
      if (panel.id.startsWith('diff-')) panel.api.updateParameters({ colorScheme: props.colorScheme });
    }
  }, [props.colorScheme]);

  const [error, setError] = React.useState<string | null>(null);
  const addCard = useCallback(async () => {
    // ⊕ flow: pick a folder, spawn, bind the card (E3-02/E3-04)
    const folder = await window.switchboard.sessions.pickFolder();
    if (!folder) return;
    try {
      await addSessionCard(folder);
    } catch (e) {
      // our breakage must be visible, not mute (fail-open)
      setError(String(e));
    }
  }, [addSessionCard]);

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      // A fresh grid is coming up: no layout sweep may run until its restore is
      // finished (see gridReady). Reset rather than assume, so a remount — dev
      // HMR today, anything else later — cannot start with the flag left true
      // from the grid before it.
      gridReady = false;

      // Own the theme outright (#84). dockview stamps its theme class on the
      // SHELL — an element we don't render — and defaults to `abyss`; that's
      // why the tab-overflow dropdown (a popup mounted on the shell) came out
      // dark inside our light app. Registering our own theme puts OUR class up
      // there, so every dockview surface, popups and popout containers
      // included, resolves the variables in theme/dockview-tokens.css.
      api.updateOptions({ theme: dockviewTheme(props.colorScheme) });

      const report = () => props.onCardsChanged(api.panels.map((p) => p.id));
      const saveLayout = () => {
        try {
          window.switchboard.workspace.setLayout(api.toJSON());
        } catch {
          // a nudge arriving mid-teardown finds a disposed dockview; the
          // geometry is nice-to-have, never a reason to throw in an IPC callback
        }
      };
      api.onDidLayoutChange(() => {
        report();
        saveLayout();
        // remember where each card sits WHILE it still has a panel to ask —
        // a hidden card has none, and reveal has to know (P2-E15-08)
        captureSlots(api);
      });
      // Moving/resizing a popped-out window isn't a layout mutation, so persist
      // its geometry on those events too — else a dragged popout forgets its
      // spot on relaunch (E8-04 multi-monitor).
      //
      // These dockview events are kept, but they are NOT sufficient: dockview
      // detects the move with a debounced requestAnimationFrame poll of
      // screenX, and rAF throttles in a backgrounded window — precisely the
      // state this window is in while you drag a popout across monitors. Quit
      // before the poll catches up and the stale open-time position is what
      // gets restored (#86). Electron's own move/resize events don't care about
      // focus, so the main process nudges us and we re-read the truth here.
      // a moved/resized popout changes a card's SLOT as well as the layout —
      // its monitor is exactly what §5.8's reveal contract promises to restore
      const saveGeometry = (): void => {
        saveLayout();
        captureSlots(api);
      };
      api.onDidPopoutGroupPositionChange?.(saveGeometry);
      api.onDidPopoutGroupSizeChange?.(saveGeometry);
      const offPopoutGeometry = window.switchboard.onPopoutGeometryChanged?.(saveGeometry);
      window.addEventListener('beforeunload', () => offPopoutGeometry?.());
      // dockview tab drags don't carry our dataTransfer type — publish the
      // in-flight card so the rail's group headers can accept the drop
      api.onWillDragPanel?.((e) => {
        const m = /^session-(.+)$/.exec(e.panel?.id ?? '');
        setDraggedCard(m ? m[1] : null);
      });
      window.addEventListener('dragend', () => setDraggedCard(null));
      // remember which card has focus (E12-08); restored below after fromJSON
      api.onDidActivePanelChange((e) => {
        const m = e.panel ? /^session-(.+)$/.exec(e.panel.id) : null;
        if (m && !sessionStore.isRestoringLayout() && !sessionStore.isTearingDown())
          uiSet('focusedCardId', m[1]);
        // the rail's selected tint follows the grid even mid-restore: it is a
        // read-only reflection, not persisted state
        props.onActiveCardChanged?.(m ? m[1] : null);
      });
      // E8 diagnostics: surface popout success/failure
      api.onDidOpenPopoutWindowFail?.(() => console.error('[popout] onDidOpenPopoutWindowFail'));
      // Publish popout windows to the shared registry (#227): their DOM lives
      // in another OS window, their JS lives here, and three features need to
      // know which ones are open — the keyboard dispatcher (E9-02), the theme
      // and tab-row flags (#84), the read-only notice (#208). dockview is the
      // authority on which popouts exist; this is the one place that says so.
      api.onDidAddPopoutGroup?.((e: PopoutGroup) => {
        console.log('[popout] onDidAddPopoutGroup (opened OK)');
        if (e.window) addPopoutWindow(e.window);
      });
      api.onDidRemovePopoutGroup?.((e: PopoutGroup) => {
        if (e.window) removePopoutWindow(e.window);
      });
      // window teardown must not be mistaken for the user closing cards
      window.addEventListener('beforeunload', () => {
        sessionStore.setTearingDown(true);
      });
      // closing a card (tab X or the overlay) forgets it — it will NOT come
      // back next launch. Quitting keeps the record so sessions DO come back,
      // so we skip this during teardown (belt-and-suspenders vs Dockview
      // disposal ever firing removes).
      api.onDidRemovePanel((panel) => {
        if (sessionStore.isTearingDown()) return;
        const m = /^session-(.+)$/.exec(panel.id);
        if (!m) return;
        // hiding removes the panel too, and means the opposite: keep the record
        // AND the running session (P2-E15-08)
        if (sessionStore.isHiding(m[1])) return;
        sessionStore.forgetCardLiveIds(m[1]);
        sessionStore.forgetPresentation(m[1]);
        // ...including a maximize held for it: a stale one would leave the
        // workspace blown up around nothing AND make the default mode start
        // enforcing (E9-07, lib/layout-mode's isEnforced)
        sessionStore.forgetLayoutCard(m[1]);
        void window.switchboard.sessions.closeCard(m[1]);
      });

      // FAIL-OPEN, and specifically: whatever happens in here, layout sweeps
      // must end up armed. Two awaits below can reject — reading the saved
      // workspace, and spawning the scripted-check seed session — and an early
      // exit through either used to leave `gridReady` false for the life of the
      // window, which silently turned the layout chip, all four palette entries
      // and both bindings into no-ops. A layout mode is a convenience; it must
      // never be able to fail QUIETLY (E9-07).
      try {
        const saved = await window.switchboard.workspace.getLayout();
        if (saved) {
          // Resolved BEFORE the restore's try/catch, not inside it: an await in
          // there whose rejection is unrelated to the layout would abort the
          // stale-panel cleanup and the focus restore, and report itself as
          // "[layout] restore failed". `null` means "we do not know", which the
          // prune below treats as "prune no groups".
          const groupIds = await window.switchboard.groups
            .list()
            .then((gs) => gs.map((g) => g.id))
            .catch(() => null);
          try {
            // popouts persist in the layout, but their stored url has last
            // launch's (random) loopback port and their position may be on a
            // now-missing monitor — fix both before restoring (E8-02)
            const workAreas = await window.switchboard.workAreas();
            const rescuedNow: RescuedPopout[] = [];
            const sane = sanitizePopoutLayout(saved, window.location.origin, workAreas, rescuedNow);
            // How many popouts the saved layout asked for, before dockview tries
            // to reopen them. Pairs with the main process's "popout geometry
            // flushed" line to say which side of the quit lost one (#165).
            const asked = (sane as { popoutGroups?: unknown[] })?.popoutGroups?.length ?? 0;
            if (asked > 0) console.log(`[layout] restoring ${asked} popout(s)`);
            sessionStore.setRestoringLayout(true);
            try {
              api.fromJSON(sane as Parameters<DockviewApi['fromJSON']>[0]);
            } finally {
              sessionStore.setRestoringLayout(false);
            }
            // stash what was rescued so the display-reconnect offer (E8-06) can
            // put it back — appended, cleared only by an accepted restore
            if (rescuedNow.length > 0) {
              uiSet('rescuedPopouts', [...uiGet<RescuedPopout[]>('rescuedPopouts', []), ...rescuedNow]);
            }
            // keep restored session cards that still have a persisted record
            // (they resume-on-focus); drop any panel with no record behind it.
            // Diff panes are derived — always drop and let the user reopen.
            const known = new Set(
              (await window.switchboard.sessions.knownCards()).map((c) => c.cardId)
            );
            // presentation records outlive their panels by design (that is the
            // point of hiding), so the only thing that can retire one is the card
            // itself being gone — otherwise the blob grows for ever
            sessionStore.prunePresentation(known);
            // the presentation POLICY overrides (E9-06) are keyed the same way and
            // outlive their cards the same way, so they are retired at the same
            // moment. A FAILED group list keeps every group override rather than
            // pruning against an empty set: "the IPC rejected" and "you have no
            // groups" are the same value otherwise, and one of them would silently
            // delete settings the user made.
            sessionStore.prunePolicies(known, groupIds ?? Object.keys(sessionStore.getPolicies().groups));
            // and E9-07's maximize, which names a card and snapshots every other
            // card's rung: a maximize held for a session that has since been
            // closed would keep the workspace blown up around nothing.
            sessionStore.pruneLayout(known);
            for (const p of [...api.panels]) {
              const s = /^session-(.+)$/.exec(p.id);
              const d = /^diff-/.exec(p.id);
              if (d || (s && !known.has(s[1]))) api.removePanel(p);
            }
            // land the user exactly where they were (§5.25): refocus the saved
            // card — resume-on-focus then brings that session back first
            const focused = uiGet<string | null>('focusedCardId', null);
            if (focused) api.getPanel(`session-${focused}`)?.focus();
          } catch (err) {
            // Fail-open: unusable layout JSON -> fresh grid, never a crash. But
            // SILENT fail-open was indistinguishable from "the saved layout had
            // nothing in it" — the two look identical from outside, and a restore
            // that throws part-way loses every popout with it. Say so; the
            // renderer console is forwarded into switchboard.log (#165).
            console.error(`[layout] restore failed: ${String(err)}`);
          }
        }
        for (let i = api.panels.length; i < props.seedPanels; i++) {
          counter.current += 1;
          api.addPanel({
            id: `seed-${counter.current}`,
            component: 'sessionCard',
            title: t('grid.cardTitle', { n: i + 1 }),
          });
        }
        // scripted-check seam: one REAL session without the folder dialog
        const seedFolder = window.switchboard.seedSessionFolder;
        if (seedFolder) {
          await addSessionCard(seedFolder);
        }
        report();
      } catch (err) {
        // the renderer console is forwarded into switchboard.log (#165)
        console.error(`[grid] bring-up failed: ${String(err)}`);
      } finally {
        // The grid is up and the restore is finished: layout sweeps may run
        // (E9-07). One 'react' pass now applies a restored mode
        // deterministically, instead of leaving it to whenever the first
        // session refresh lands — 'react' and not 'switch' because the default
        // mode's plan is "every session gets a card", and re-expanding at boot
        // everything the user collapsed before quitting is the opposite of
        // §5.25.
        gridReady = true;
        applyLayout(api, 'react');
      }
    },
    [] // onReady fires exactly once; props.seedPanels is read at that moment
  );

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minInlineSize: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 'var(--grid-pad)',
          paddingBlockEnd: 0,
        }}
      >
        {error && (
          <span style={{ color: 'var(--status-crashed-ink)', fontSize: 11, alignSelf: 'center' }}>
            {error}
          </span>
        )}
        <button
          onClick={() => void addCard()}
          style={{
            background: 'var(--chip)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '3px 10px',
            cursor: 'pointer',
            fontSize: 11,
            fontFamily: 'var(--font-ui)',
          }}
        >
          {t('grid.addCard')}
        </button>
      </div>
      <div style={{ flex: 1, padding: 'var(--grid-pad)' }}>
        <DockviewReact
          components={components}
          defaultTabComponent={IdentityTab}
          onReady={(e: DockviewReadyEvent) => void onReady(e)}
          /* the theme lives on the SHELL, set via api.updateOptions in onReady
             (#84) — a class here never reached the popups */
        />
      </div>
    </main>
  );
}
