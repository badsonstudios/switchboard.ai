// Session grid (P1-E3-01): Dockview-powered card grid. Cards are placeholders
// until E3-02 wires terminals in. Layout serializes to the workspace store on
// every change and restores on boot.
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DockviewReact,
  DockviewReadyEvent,
  DockviewApi,
  DockviewGroupPanel,
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
import { IdentityChip, identityBadgeStyle } from './IdentityChip';
import { DiffPane } from './DiffPane';
import { DocumentViewer } from './DocumentViewer';
import { baseName } from '../lib/document-kind';
import {
  closableDocuments,
  forgetDocumentPanel,
  isDocumentPanelId,
  planDocumentOpen,
} from '../lib/document-panels';
import { UsageStrip } from './UsageStrip';
import { GitContext, GitStatusDto } from './GitContext';
import { Usage, ZERO_USAGE } from '../lib/usage';
import type { BindingDiagnostics, BindingState } from '../../../shared/transcripts';
import {
  Box,
  boxOnAnyDisplay,
  isDerivedPanelId,
  prunePopoutGroups,
  RescuedPopout,
  sanitizePopoutLayout,
} from '../lib/layout';
import type { SlotRef } from '../lib/dock-slot';
import {
  captureSlot,
  homeGroupId,
  keepsInheritedGroup,
  openerRelative,
  placeAt,
} from '../lib/dock-slot';
import { hasPanel, slotIsLive, stepDown, stepUp } from '../lib/ladder';
import { autonomyTooltip, DEFAULT_AUTONOMY, isAutonomy, nextAutonomy } from '../lib/autonomy';
import { submitTarget } from '../lib/presentation-policy';
import { bulkClose } from '../lib/pinning';
import { newSessionHostGroup } from '../lib/new-session-target';
import { createSweeper, SweepPort, SweepRequest } from '../lib/layout-sweep';
import { sharedAnnouncer } from '../lib/announcer';
import { CardSound, nextCardSound } from '../../../shared/sounds';
// #440: a refused call RESOLVES a truthy object — read a bridge answer through
// `answered()` (or `took()`), never as a bare truthiness test.
import { answered, isIpcRefusal } from '../../../shared/ipc/refusal';
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
import { addPopoutWindow, removePopoutWindow, subscribePopoutWindows } from '../lib/popout-windows';
import { strandedByGroup } from '../lib/popout-rescue';
import { uiGet, uiSet } from '../lib/ui-state';
import { pruneDrafts } from '../lib/composer-draft';
import { pruneAttachmentDrafts } from '../lib/composer-attachment-draft';
import { setDraggedCard } from '../lib/drag-context';
import { findBarState, subscribeFindBar } from '../lib/find-bar-state';
import { FindBar } from './FindBar';
import { sendSessionCommand } from '../lib/composer';
import { DEFAULT_SESSION_TRANSPORT, type TransportKind } from '../../../shared/transport';
import type { AutonomyMode, SessionStatus } from '../../../shared/sessions';
import { srOnly } from './sr-only';
import {
  dropRetired,
  dropAnswered,
  enqueueHeld,
  HeldPermission,
  IncomingPermission,
  intakePermission,
} from '../lib/held-permissions';

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
  autonomy?: AutonomyMode;
  /** the record's status at bind time — a card that ADOPTED a running session
   *  (reveal, P2-E15-08) must not claim 'starting': no further push is coming
   *  for an idle session, and the card would sit there lying about it */
  status?: SessionStatus;
  /** which transport hosts it (P2-E18-08b) — the Terminal tab needs to know.
   *  Not optional: a live session always has one (#445), and an optional field
   *  here is an invitation to invent a default for it. */
  transport: TransportKind;
}

/**
 * Why a card is showing the "there is no session here" overlay (#355).
 *
 * Two states that used to be one. A session that RAN and then exited is not the
 * same thing as a session that never started — the card used to say "Session
 * ended — Exited unexpectedly (code -1)" for both, and for the second one every
 * word of that is false: nothing ended, nothing exited, and the `-1` is a code
 * this renderer made up because it had nowhere to get a real one.
 *
 * `never-started` carries nothing, deliberately. The REASON lives in the app log
 * (#347): `sessions:create` answers `null` for a start it refused and logs which
 * card, which folder and why, and widening the IPC result to carry that back
 * would be re-architecting the lifecycle for a sentence. The overlay says what
 * it honestly knows and the log says the rest — which is exactly what the
 * manual's troubleshooting entry sends the user to.
 */
export type CardEnded =
  | { kind: 'exited'; code: number; crashed: boolean }
  | { kind: 'never-started' };

/**
 * The i18n keys the ended overlay renders, for one `CardEnded` (#355).
 *
 * A pure function and an export because the overlay itself is unreachable in
 * unit-land — `SessionCardPanel` needs a live dockview — and the thing worth
 * pinning is precisely the mapping: which words go with which state. The
 * component does the `t()` calls; this decides what to translate.
 */
export function endedCopy(ended: CardEnded): {
  heading: string;
  detail: string;
  /** ICU args for `detail`, when it takes any */
  detailVars?: Record<string, unknown>;
  /** the primary button — "Restart" only makes sense for something that ran */
  action: string;
} {
  if (ended.kind === 'never-started') {
    return {
      heading: 'grid.sessionNotStarted',
      detail: 'grid.notStartedHint',
      action: 'grid.tryAgain',
    };
  }
  return {
    heading: 'grid.sessionEnded',
    detail: ended.crashed ? 'grid.exitCrashed' : 'grid.exitClean',
    detailVars: { code: ended.code },
    action: 'grid.restart',
  };
}

/**
 * The status pill an ENDED card's header wears (#606).
 *
 * Separate from `endedCopy` and not another field on it: that one is the
 * OVERLAY's words, it is asserted with `toEqual`, and a pill is a different
 * register — the overlay explains, the pill names the state in one word, the
 * way every other header does.
 *
 * WHICH ARM ACTUALLY REACHES THIS, and it is narrower than the type suggests:
 * a session that RAN and then died keeps `live` (`onExited` sets `ended` and
 * deliberately does not clear the record — see the comment there), so a crashed
 * card renders through the LIVE arm, which has always had a header and takes
 * `status` for its pill. The headerless arm this exists for is the one where
 * `live` is null and `ended` is not, and today that is `never-started` alone.
 * The `exited` answers below are therefore the total function's honest ones
 * rather than a claim about pixels: they are here so that routing the live
 * header through this — the obvious next step if anyone wants ONE pill rule for
 * dead cards - is a one-line change and not a decision to re-take.
 *
 * The word comes out of the SAME vocabulary the rail rows, the urgency lamps
 * and the collapsed rows read (`presentStatus`), so a dead card cannot look
 * like one state here and another one in the list beside it:
 *
 *   • a session that ran and CRASHED  → `crashed`, the ramp's alarm position;
 *   • a session that closed cleanly   → `done`, which is what it is;
 *   • a session that NEVER STARTED    → the neutral `idle` position, with its
 *     own word. It is not "idle" — nothing is sitting there waiting — but the
 *     ramp has no seventh colour and inventing one would paint a hue the
 *     contrast tests never measured (#221). The colour says "nothing is
 *     happening"; the word says which nothing.
 */
export function endedPill(ended: CardEnded): { status: string; labelKey: string } {
  if (ended.kind === 'never-started') return { status: 'idle', labelKey: 'status.notStarted' };
  return ended.crashed
    ? { status: 'crashed', labelKey: 'status.crashed' }
    : { status: 'done', labelKey: 'status.done' };
}

/**
 * What the card's live region should be SAYING right now — the keys, not the
 * words (#358).
 *
 * Both card overlays were silent to a screen reader: they arrive as plain divs
 * with no live region, so a user who is not sitting on the card learns nothing
 * when a session dies, refuses to start, or suspends. #355 made that worse by
 * making the two ended messages worth distinguishing.
 *
 * This exists as an exported pure function for the same reason `endedCopy` does:
 * the overlay needs a live dockview and is unreachable in unit-land, and the
 * part worth pinning is the DECISION — which overlay is on screen, and therefore
 * what the region must not contradict. It mirrors the render's branch order
 * exactly (live→ended over the panel, else suspended, else ended), because a
 * region that announces the suspended copy while the ended panel is drawn is a
 * worse bug than saying nothing.
 *
 * `null` for the "Resuming…" state deliberately: that is the card's ordinary
 * boot, not an event, and it is already gone by the time a polite region would
 * get to it.
 */
export function overlaySaid(card: {
  live: boolean;
  suspended: boolean;
  ended: CardEnded | null;
}): { heading: string; detail: string; detailVars?: Record<string, unknown> } | null {
  // an ended session's panel wins while the card is live (it is drawn OVER the
  // views); once it is not, `suspended` is the branch that renders
  if (card.ended && (card.live || !card.suspended)) {
    const { heading, detail, detailVars } = endedCopy(card.ended);
    return { heading, detail, detailVars };
  }
  if (!card.live && card.suspended) {
    return { heading: 'grid.suspended', detail: 'grid.suspendedHint' };
  }
  return null;
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
  // ...and the rest of the identity, from the same place (#312). `IdentityChip`
  // has rendered an accent dot and a language badge since it was written, and
  // this — the only site in src/ — passed neither, so every card tab painted the
  // same grey dot while the header below it drew the card's real accent. §5.11:
  // one identity, rendered IDENTICALLY everywhere it appears.
  //
  // A STORE read, not a `CardParams` field: params are frozen into the dockview
  // layout blob at `addPanel` and survive restarts, so an accent threaded
  // through them would be a second copy that a re-assignment could not reach —
  // the exact bug `storeTitle` above exists to undo. The store's copy comes from
  // `sessions:cards`, whose `accent` is `record.identity.accentColor`: the same
  // field, from the same record, that the header's border reads.
  const accent = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getCardAccent(cardId)
  );
  const badge = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getCardBadge(cardId)
  );
  // WHAT THE ✕ ACTUALLY DOES, said in three strings rather than one (#543).
  //
  // Every tab in the app used to be titled "Close (ends the session)", which is
  // true of a session card and false of everything else this same component
  // draws a tab for: a `doc-` viewer closes no session, and neither does a
  // `diff-` Changes tab. #530 made the first one load-bearing — the ✕ is now
  // the ONLY way to close a document — but the second was always wrong, and the
  // rule below fixes the sentence rather than one instance of it.
  //
  // The condition is the one the click handler already branches on: `cardId` is
  // exactly "closing this ends a session", which is why it is also what decides
  // whether we confirm. A tab with no card is then a document or a derived
  // panel, told apart by the id prefix — `isDocumentPanelId`, the same
  // authority commands use.
  //
  // `?? ''` because a unit fake may hand this component a panel api with no id;
  // dockview always sets one.
  const closeLabelKey = cardId
    ? 'grid.closeTab'
    : isDocumentPanelId(props.api.id ?? '')
      ? 'grid.closeDocumentTab'
      : 'grid.closeDerivedTab';
  return (
    <div style={{ paddingInline: 8, display: 'flex', alignItems: 'center', gap: 4, blockSize: '100%' }}>
      {/* undefined accent/badge are passed through as undefined on purpose: the
          chip's own fallbacks (grey dot, no badge) stay the behaviour for a
          derived tab and for a card the store has not answered for yet. */}
      <IdentityChip title={title} accent={accent} badge={badge} compact />
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
        title={t(closeLabelKey)}
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
  // Why this card has no session: it ended, or it never started (#355). Named
  // `ended` and not `exited` because the second case did not exit.
  const [ended, setEnded] = React.useState<CardEnded | null>(null);
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
  const [status, setStatus] = React.useState<SessionStatus>('starting');
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
  // The rest of the identity, for the header a card draws while it has NO live
  // session (#216, the suspended state). `live.accent` / `live.badge` below are
  // the same two fields off the session record; these are the card record's
  // copy, which is the one that still exists when the session does not — the
  // same pair, from the same `sessions:cards` push, that the card TAB reads.
  const cardAccent = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getCardAccent(cardId)
  );
  const cardBadge = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getCardBadge(cardId)
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
    const next = nextAutonomy(cardAutonomy);
    setCardAutonomy(next);
    void window.switchboard.sessions.setAutonomy(cardId, next);
  };
  // per-card transport (P2-E18-08b). Applies on the NEXT spawn, exactly like
  // autonomy above — the CLI cannot change either on a live session. It is
  // ACCEPTED either way; when a session is running we say the change is queued
  // rather than implying it took effect.
  //
  // Seeded from the shared default rather than a hard-coded `'pty'` (#381).
  // Defence in depth: the menu only renders for a LIVE session and the create
  // response sets this in the same batch as `live`, so the seed is not
  // observable today — but it is the answer this component gives if it is ever
  // asked before main has answered, and that answer should not be a second
  // opinion about what the default is.
  const [cardTransport, setCardTransport] = React.useState<TransportKind>(
    DEFAULT_SESSION_TRANSPORT
  );
  const [transportPending, setTransportPending] = React.useState(false);
  const toggleTransport = (): void => {
    if (!cardId) return;
    const next = cardTransport === 'stream' ? 'pty' : 'stream';
    void window.switchboard.sessions.setTransport(cardId, next).then((answer) => {
      // #650: `{ok:false, reason}` is this channel's own way of saying no, and
      // a broker refusal is a THIRD thing that is neither - `r.ok` off the
      // brand is `undefined`, so this read happens to bail, but only by luck.
      // `answered` makes a refusal take the same path the handler's own no
      // takes: the switch does not move, because nothing switched.
      const r = answered(answer);
      if (!r?.ok) return;
      setCardTransport(next);
      setTransportPending(!!r.pending);
    });
  };
  // Per-session "notify when done" (P2-E14-03, §5.9). It lives in this menu
  // rather than the composer's options row because it is a durable property of
  // the CARD — like the transport switch directly above it — not a choice
  // about the next prompt, and because the composer is gone entirely from the
  // Terminal tab and from a collapsed card, where the setting must still be
  // reachable. Its whole implementation in main is a RULE; the checkbox is
  // just the rule's on/off.
  //
  // The state is main's, not this component's: it is read back after every
  // write so a refused write (an unknown card, a store that cannot save)
  // reverts the tick instead of leaving it lying about what will happen.
  // The bridge is TYPED as always-present and is, in the shipped app — but this
  // component also mounts against partial bridges (the renderer unit harnesses
  // install the namespaces they need), and a preload older than this API would
  // be another. Read it as optional and let the tick-box simply not appear:
  // "notify when done" is a notification nicety, and P6 says our breakage never
  // costs the user their session. A missing namespace must not throw out of an
  // effect and take the whole card down with it — which is exactly what it did
  // to 14 of #444's transport tests before this guard existed.
  const rulesApi = window.switchboard?.rules as typeof window.switchboard.rules | undefined;
  const [notifyWhenDone, setNotifyWhenDone] = React.useState(false);
  React.useEffect(() => {
    if (!cardId || !rulesApi) return;
    let alive = true;
    void rulesApi
      .notifyWhenDone(cardId)
      .then((on) => {
        if (alive) setNotifyWhenDone(on === true);
      })
      .catch(() => {
        /* fail-open: an unreadable rule shows as off, which is the quiet answer */
      });
    return () => {
      alive = false;
    };
  }, [cardId, rulesApi]);
  const toggleNotifyWhenDone = (): void => {
    if (!cardId || !rulesApi) return;
    const next = !notifyWhenDone;
    setNotifyWhenDone(next); // optimistic; the answer below is the truth
    void rulesApi
      .setNotifyWhenDone(cardId, next)
      .then((on) => setNotifyWhenDone(on === true))
      .catch(() => setNotifyWhenDone(!next));
  };
  // held permissions awaiting decisions (E10-04) — a QUEUE, not a slot:
  // parallel tool calls each hold their own request (review P0#4)
  // The entry shape moved to `lib/held-permissions` with the rules that build
  // and prune it (#310), so the queue and its reducers cannot drift apart.
  const [permQueue, setPermQueue] = React.useState<HeldPermission[]>([]);
  // …minus whatever §5.8's grouped prompt is currently asking on behalf of
  // several sessions at once (P2-E9-11). One question, one place to answer it:
  // a card that also drew its own bar for a grouped request would show the user
  // the same question twice with two different button sets, and let them answer
  // for one session in a card headed "2 sessions want…".
  //
  // The direction of this coupling is the safe one, and it is the only reason a
  // shell surface is allowed to take a question off a card at all: the set only
  // ever names requests a RENDERED group is holding, and it empties the instant
  // that group dissolves — so the worst a bug in it can do is ask twice.
  // NOTHING here can make a held request appear nowhere. The queue itself is
  // untouched; a request that leaves the group is back on this bar on the next
  // render, still held, still answerable.
  //
  // EXCEPT in a pop-out. The grouped card lives in the app shell, and a
  // popped-out panel is portalled into a DIFFERENT WINDOW that has no shell —
  // so for a user working in that window, suppressing here would take the
  // question off the only screen they are looking at. This card keeps its own
  // bar there and the group keeps its row: two windows, two placements of one
  // question (§5.16 names three, and calls placement a preference). Both
  // answer through the same request id, so whichever is used resolves the other.
  const batchedIds = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getBatchedRequestIds()
  );
  const cardQueue = React.useMemo(
    () => (poppedOut ? permQueue : permQueue.filter((p) => !batchedIds.has(p.requestId))),
    [permQueue, batchedIds, poppedOut]
  );
  const perm = cardQueue[0] ?? null;
  // this card has a held question, and the grouped prompt is the one asking it.
  // The handoff bar reads this: "no bar here" must not become "switchboard
  // can't answer it, go to the terminal" when switchboard is answering it eight
  // pixels lower (#125's defect, one surface over).
  const permBatched = cardQueue.length < permQueue.length;
  // "an answer just went out" — the window that keeps the terminal-handoff bar
  // off the screen while the resolution makes its IPC round trip. Declared HERE,
  // above both of its writers: the intake effect (auto-allow, #310) opens it too,
  // and a setter read before its own `useState` line is a hazard nobody should
  // have to reason about. Its timer and its clear live with `decide`.
  //
  // A COUNTER, not a boolean, and #310 is why. Setting a boolean that is already
  // `true` is a React bail-out: no re-render, no effect re-run, so the 2s timer
  // keeps its ORIGINAL deadline. That was survivable while only the manual
  // Allow/Deny path opened the window — two clicks inside two seconds are rare —
  // but an allow-all session opens it on EVERY gated call, so back-to-back is
  // the normal case there, and the second call would have inherited whatever was
  // left of the first one's window. A counter always changes, so the effect
  // always re-arms.
  const [decidedSeq, setDecidedSeq] = React.useState(0);
  const recentlyDecided = decidedSeq > 0;
  const noteDecided = (): void => setDecidedSeq((n) => n + 1);
  // ⋯ session-controls menu (E10-07, §5.17): GUI sugar that TYPES the real
  // slash command into the PTY — the CLI stays the source of truth
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  /**
   * Whatever went wrong creating a session from THIS card's ＋ (#531).
   *
   * Local to the card and not the grid's `error`, because the grid's banner is
   * painted in the MAIN window — and the ＋ only exists while this card is out
   * in a popout, i.e. exactly when the user cannot see that banner. Our
   * breakage has to be visible where it happened (fail-open), which means in
   * the window that asked.
   */
  const [cardError, setCardError] = React.useState<string | null>(null);
  // ── this card's notification cue (P2-E14-05a, §5.9 + §5.11) ───────────────
  //
  // Same defensive bridge read as `rulesApi` above and for the same reason: a
  // namespace a partial bridge does not install must not throw out of an effect
  // and take the card down with it (#444).
  const soundsApi = window.switchboard?.sounds as typeof window.switchboard.sounds | undefined;
  const [cardSound, setCardSound] = React.useState<CardSound | null>(null);
  /** newest write wins — two fast clicks must not repaint in the wrong order */
  const soundSeq = React.useRef(0);
  // Read when the MENU OPENS, not once on mount. A card mounts before
  // `sessions:create` has persisted its record, so a mount-time read asks about
  // a card main does not have yet and is answered `null` — and with no other
  // trigger the entry would then stay hidden for the life of the card. Opening
  // the menu is also the only moment the answer is looked at, which makes this
  // the cheapest possible fix for the staleness #421 flagged: nothing else in
  // the app can change a cue behind this view without it being re-read.
  React.useEffect(() => {
    if (!cardId || !soundsApi || !menuOpen) return;
    let alive = true;
    const seq = ++soundSeq.current;
    void soundsApi
      .get(cardId)
      .then((s) => {
        // #440: `?? null` does not catch a refusal — it is an object, not
        // nullish — so it would land in state and the menu would read `.id`
        // off the brand.
        if (alive && seq === soundSeq.current) setCardSound(answered(s) ?? null);
      })
      .catch(() => {
        /* fail-open: an unreadable cue shows nothing rather than a wrong one */
      });
    return () => {
      alive = false;
    };
  }, [cardId, soundsApi, menuOpen]);
  /**
   * Step to the next cue and PLAY it.
   *
   * A cycling button, like the transport entry above and the title bar's
   * autonomy and layout chips — this codebase's shape for "one of a short
   * closed list". A dropdown of eight would be a second menu inside a menu that
   * is not even a real one (see the ARIA note below).
   *
   * The preview is not a nicety: a list of eight words — chime, bell, knock —
   * tells nobody what they will hear, and this is the only place in the app
   * where a sound can be auditioned on purpose rather than waited for.
   *
   * The cycle has NINE steps, not eight: past the last cue it comes back to
   * **automatic**, because a control you can only walk one way is a trap. There
   * is no preview for that step — "automatic" is not a sound, and playing the
   * cue it happens to resolve to would say the opposite of what was chosen.
   */
  /** A cue's name for the menu; `null` is the automatic step. */
  const soundName = (id: string | null): string =>
    id ? t(`sounds.${id}`) : t('sounds.auto');
  const cycleSound = (): void => {
    if (!cardId || !soundsApi) return;
    const next = nextCardSound(cardSound);
    setCardSound(next ? { id: next, pinned: true } : null); // optimistic
    if (next) sharedAnnouncer().play(next);
    const seq = ++soundSeq.current;
    void soundsApi
      .set(cardId, next)
      .then((s) => {
        if (seq !== soundSeq.current) return; // a later click already answered
        // A REFUSED write answers `null`, which is also what "back to auto"
        // answers — so ask rather than guess, and let the menu show the truth
        // instead of the thing that was just clicked. (A refusal from the
        // BROKER is a third thing again, and `answered` folds it in here —
        // #440: without it the truthy brand would be set as the cue.)
        const cue = answered(s);
        if (cue) setCardSound(cue);
        else void soundsApi.get(cardId).then((truth) => setCardSound(answered(truth) ?? null));
      })
      .catch(() => {
        /* leave the optimistic value: the next menu open re-reads the truth */
      });
  };
  // locked while starting (§5.10 startup-dialog rule) or once the live
  // session is gone — a PTY write to a dead session is a silent no-op
  const controlsLocked = status === 'starting' || status === 'crashed' || ended !== null;
  const spawning = React.useRef(false);
  const folder = props.params?.folder;
  // What the card CALLS itself, on screen (#250). The store's copy first, so a
  // rename from the rail reaches the header — `props.api.title` alone is the
  // name the card was born with. Chain and its empty-is-absent rule live in
  // lib/card-title.
  const headerTitle = cardHeaderTitle(cardTitle, props.api.title, folder);

  React.useEffect(() => {
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);

  // "dockview just moved your DOM" (#555) — see `PanelContext.dockEpoch`.
  //
  // Activating a group re-runs dockview's `openPanel`, which DETACHES this
  // panel's content element and appends it again; a move between groups
  // relocates the whole subtree. Neither is a render — the same elements come
  // back, so React is not involved — but the browser resets the `scrollTop` of
  // every scroll container inside them on the way through, and fires nothing.
  //
  // MEASURED (#555, two docked groups, click a card's own rail row): the feed
  // went from scrollTop 1491 to 0, and the only observer that saw anything at
  // all was a `MutationObserver` on the whole document. An `IntersectionObserver`
  // on the scroller delivered its initial reading and never fired again, and a
  // `ResizeObserver` never fired because the panel comes back at exactly the
  // size it left — which also takes out the detach backstop living inside the
  // feed's own resize handler.
  //
  // So the card, which is the thing dockview actually talks to, passes the fact
  // down. All three events are subscribed rather than the one that happens to
  // fire today: they are rare, the handler is a counter, and a panel that
  // reconciles a scroll position it is already sitting at has done nothing.
  const [dockEpoch, setDockEpoch] = React.useState(0);
  React.useEffect(() => {
    const bump = (): void => setDockEpoch((n) => n + 1);
    const ds = [
      props.api.onDidActiveChange(bump),
      props.api.onDidGroupChange(bump),
      props.api.onDidLocationChange(bump),
    ];
    return () => ds.forEach((d) => d.dispose());
    // props.api is stable for the panel's lifetime
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
    if (!visible || live || ended || suspended || spawning.current || !cardId || !folder) return;
    spawning.current = true;
    // titlebar autonomy chip applies to NEW cards; main keeps a card's own
    // autonomy across resumes
    const stored = uiGet<string>('autonomy', DEFAULT_AUTONOMY);
    const autonomy = isAutonomy(stored) ? stored : DEFAULT_AUTONOMY;
    // A start that did not happen, from either of the two ways to learn that
    // (#347). `sessions:create` used to REJECT for everything — bad input, a
    // folder that is gone, a spawn that failed — and this effect's `.catch` was
    // the only thing between that and an unhandled renderer rejection. Main now
    // ANSWERS `null` for a start it refused or could not do, so the ordinary
    // cases are a value to read; the `.catch` stays for the extraordinary one
    // (a throw from the wiring after the session is already live) and for the
    // broker's capability refusal, which rejects every channel by design.
    //
    // Both land here, because the card's answer to "it did not start" is one
    // answer: show the overlay with Try again and Close. The console line is for
    // whoever is looking at devtools; the REASON is in the app log, which is the
    // half that did not exist before this change.
    //
    // `never-started` and not the `exited` state the overlay used to be given
    // (#355): the card is showing this because no session ever ran in it, so
    // "Session ended — Exited unexpectedly (code -1)" was three false claims and
    // an invented exit code. The `.catch` branch says the same thing, and it is
    // the one worth arguing: a throw from the wiring AFTER a successful spawn
    // could in principle leave a live session this card never bound to. It is
    // not reachable today — #347 audited those three steps and none of them
    // throws — and the two refusals that ARE reachable (main declining, the
    // broker declining a capability) both mean nothing started. If a
    // post-spawn throw is ever introduced, that is the bug to fix, not this copy.
    const startFailed = (why: unknown): void => {
      console.warn(`[sessions] session did not start for ${cardId} — see the app log`, why ?? '');
      setEnded({ kind: 'never-started' });
    };
    void window.switchboard.sessions
      .create({ cardId, folder, title: props.api.title ?? folder, autonomy, groupId: props.params?.groupId })
      .then((answer) => {
        // #440: a refused `sessions:create` resolves a truthy brand, so
        // `if (!record)` would sail past `startFailed` and then throw on
        // `record.identity` from inside a `.then` — a card stuck on "starting"
        // instead of the honest "never started".
        const record = answered(answer);
        if (!record) return startFailed(null);
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
        // The card's stored choice, so the menu shows what will happen NEXT
        // spawn. Main's answer, verbatim — this line used to read
        // `record.transport === 'stream' ? 'stream' : 'pty'`, which is a
        // SECOND default for the same contract and disagreed with the one the
        // `cardTransport` state is seeded from, `DEFAULT_SESSION_TRANSPORT`
        // (#445). A live record always carries a transport — that is what
        // `SessionRecordDto` promises — so there is nothing here to default.
        setCardTransport(record.transport);
      })
      .catch(startFailed)
      .finally(() => {
        spawning.current = false;
      });
  }, [visible, live, ended, suspended, cardId, folder, props.api.title]);

  // The label can fill itself from the CLI's own conversation title (P2-E7-06),
  // and it can do it minutes after this card mounted — observed as late as line
  // 510 of a transcript. Nothing in this component asked for it, so main pushes
  // it; the header reserves its space either way, so a late arrival never
  // reflows the row.
  //
  // Bound to the CARD, not the live session: the label outlives a restart, and
  // this is also the echo of the user's own edit below (the rail shows the same
  // label and is not the caller when the grid is).
  React.useEffect(() => {
    if (!cardId) return;
    return window.switchboard.sessions.onTaskLabel?.((p) => {
      if (p.cardId === cardId) setTaskLabel(p.label ?? '');
    });
  }, [cardId]);

  // a dead session's card must be dismissable, not a stuck blank terminal
  React.useEffect(() => {
    if (!live) return;
    return window.switchboard.sessions.onExited((e) => {
      if (e.sessionId !== live.id) return;
      setEnded({ kind: 'exited', code: e.code, crashed: e.crashed });
      // The THIRD way a session's held requests stop being answerable, and the
      // one that reaches neither `forgetCardLiveIds` nor main's teardown (#239):
      // a session that dies on its own keeps its binding and its record until
      // the user restarts or closes the card. The exited overlay covers the
      // review bar for the MOUSE only — the Allow / Allow all / Deny buttons
      // stay mounted, tab-reachable and read out by a screen reader — so the
      // click this issue exists to prevent is still one Tab away. The CLI
      // process is gone, so nothing here can reach it: the honest thing is to
      // stop offering the question.
      //
      // THIS IS THE UI HALF ONLY. Main does not release a self-exited session's
      // holds — `unregisterSession` runs from `tearDownLive` and a plain exit
      // never gets there — so the parked request and its timer live on in main
      // until the 300s fail-open, and `sessions:pendingPermissions` goes on
      // advertising it to any card that mounts meanwhile. Closing that belongs
      // in main, next to `manager.onSessionExit`, and is not this change.
      setPermQueue((prev) => dropRetired(prev, e.sessionId));
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
    void window.switchboard.transcripts.binding(live.id).then((answer) => {
      // A live push that landed while this was in flight is NEWER than what we
      // asked for — it must not be overwritten by the reply.
      const b = answered(answer); // #440: a refusal is truthy, and has no `.binding`
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
        // `answered` BEFORE the cast (#650): `git:status` is declared
        // `Promise<unknown>`, and the brand cast into `GitStatusDto` is read
        // for `.files.length` by `GitContext` on the next render. Keeping the
        // previous status (or `null`, which draws no context line at all) is
        // the fail-open - a card must not lose its pane over a git read.
        const next = answered(s) as GitStatusDto | undefined;
        if (!cancelled && next) setGit(next);
      });
    };
    refresh();
    // No cast since #618: `onStatus` hands over a typed `StatusChange`, so
    // `to === 'done'` is checked against the union main can actually emit
    // rather than against `string` (which would have compiled for any typo).
    const off = window.switchboard.sessions.onStatus((change) => {
      if (change.sessionId === live.id && change.to === 'done') refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [live, visible, folder]);

  // live status for the header pill (E8-05). Backend emits a `StatusChange`.
  // Spawn starts at the RECORD's status — never assume "working" (Dan
  // 2026-07-22: resumed sessions showed the working banner doing nothing).
  //
  // The `c as { …; to?: string }` cast this used to open with was #618's second
  // widening site, and the optional `to` in it was the tell: `to` is required
  // and is a `SessionStatus`, so the `if (s.to)` guard it forced was dead code
  // guarding against a shape main cannot send.
  React.useEffect(() => {
    if (!live) return;
    setStatus(live.status ?? 'starting');
    return window.switchboard.sessions.onStatus((change) => {
      if (change.sessionId === live.id) setStatus(change.to);
    });
  }, [live]);

  // inline approvals (E10-04): held PreToolUse requests for THIS card queue
  // into a review bar; allow-all answers future ones for the LIVE session
  // only (review P0#2 — a respawn must prompt again). A hold needs eyes, so
  // it surfaces the Session tab whatever tab is active (review P0#5).
  React.useEffect(() => {
    if (!cardId) return;
    // The RULE (and, since #310, the whole handler's wiring) lives in
    // `lib/held-permissions`; this is the adapter that hands it the card's
    // ports. See `intakePermission` for why the allow-all branch suppresses the
    // handoff bar on its way out.
    const enqueue = (r: IncomingPermission): void =>
      intakePermission(r, cardId, {
        isAllowAll: (sessionId) => sessionStore.isAllowAll(sessionId),
        decide: (requestId, decision) => {
          void window.switchboard.sessions.decidePermission(requestId, decision);
        },
        queue: (req) => setPermQueue((prev) => enqueueHeld(prev, req)),
        surface: () => setView(DEFAULT_PANEL_ID),
        suppressHandoff: () => noteDecided(),
      });
    const offReq = window.switchboard.sessions.onPermissionRequest(enqueue);
    const offRes = window.switchboard.sessions.onPermissionResolved((r) => {
      setPermQueue((prev) => prev.filter((p) => p.requestId !== r.requestId));
    });
    // replay holds that arrived before this card subscribed (reload / mount
    // race) — a missed push must never park the CLI (review P0#3)
    // `answered` (#650): a refused replay would reach `.forEach` as the brand
    // and throw inside a `.then` driven with `void`. Replaying nothing is the
    // fail-open - the bar on each card still shows its own live request.
    void window.switchboard.sessions
      .pendingPermissions()
      .then((list) => (answered(list) ?? []).forEach(enqueue));
    return () => {
      offReq();
      offRes();
    };
    // setView identity is stable enough here; cardId is the real key (the
    // exhaustive-deps plugin isn't installed in this repo)
  }, [cardId]);
  // A held request belongs to the LIVE session that raised it and dies with it
  // (#239). Restart and the popout-close suspend both end the session while
  // leaving this component MOUNTED with its queue intact, so when main's release
  // is lost the next session's review bar opens holding the corpse's question:
  // `Allow` decides a request that no longer exists, and `Allow all` writes a
  // grant keyed by an id no map holds — #224's leak again, by user clicks.
  //
  // Main normally gets there first: tearing a session down releases what it is
  // holding (`tearDownLive` → `unregisterSession` / `forgetSession`) and the
  // resulting `permissionResolved` push is what usually empties this queue. This
  // is the renderer's OWN guarantee, not a second copy of that one, because
  // main's is explicitly best-effort — every step of `tearDownLive` is allowed
  // to fail and be skipped, and `tearDownStep`'s docblock names this exact
  // consequence: "a card showing a permission bar for a session that no longer
  // exists" (#219). A queue whose only correction arrives from another process
  // cannot repair itself when the correction is the thing that went missing.
  //
  // Local only — no `decidePermission` here. The request is already answered or
  // already dead; sending a verdict for it would be a decision the user never
  // made, aimed at a session that cannot receive it.
  React.useEffect(() => {
    return sessionStore.subscribeLiveRetired((liveId) => {
      setPermQueue((prev) => dropRetired(prev, liveId));
    });
  }, []);
  const decide = (decision: 'allow' | 'deny', allowAll = false, updatedInput?: unknown): void => {
    // the head of the bar's OWN list, not of the raw queue: a grouped request
    // is answered on the grouped card, and this button must never decide one
    // the user cannot see (P2-E9-11)
    const head = cardQueue[0];
    if (!head) return;
    if (allowAll) {
      // main answers future gated calls at the server — no hold/event/beep
      // (P2 #19). The local set still drains anything ALREADY queued here.
      sessionStore.setAllowAll(head.sessionId);
      void window.switchboard.sessions.allowAllSession(head.sessionId);
    }
    // `updatedInput` is the answered `AskUserQuestion` input (#563) — undefined
    // for every other surface, and main ignores it for any tool but that one.
    void window.switchboard.sessions.decidePermission(head.requestId, decision, undefined, updatedInput);
    // BY ID, not `slice(1)` (P2-E9-11). The head the user answered is the head
    // of the FILTERED list, and a grouped sibling ahead of it in the raw queue
    // makes those two different entries — `slice(1)` would answer this one and
    // silently delete that one, which is still held. See `dropAnswered`.
    // The resolved event prunes too; both are idempotent.
    setPermQueue((prev) => dropAnswered(prev, head.requestId));
    // The queue pops NOW; `permission-resolved` only comes back after a full
    // IPC round trip, so for a frame or two the card reads
    // "needs-permission with nothing held" — which is exactly the state the
    // handoff bar exists for. Without this window, answering a permission
    // flashes "switchboard can't answer it for you" where the button was
    // (#125 review). The window is generous on purpose: it costs nothing if
    // the status beats it, and a stale bar is worse than a late one.
    noteDecided();
  };
  // Keyed on the COUNTER, not on the boolean: every answer re-arms the full 2s
  // (see the declaration). The cleanup cancels the previous deadline first, so
  // consecutive answers never leave a stray timer that could close the window
  // early on the one after it.
  React.useEffect(() => {
    if (decidedSeq === 0) return;
    const id = setTimeout(() => setDecidedSeq(0), 2_000);
    return () => clearTimeout(id);
  }, [decidedSeq]);
  // a new hold means the round trip finished and the next question is live
  React.useEffect(() => {
    if (perm) setDecidedSeq(0);
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
      const cameHome = wasPopout && now !== 'popout' && !!cardId;
      // THE NOTE THE SETTLE READS (#656/#657), taken before the guards below
      // because it is bookkeeping and not a decision, and because one of the
      // gestures they exclude — the lone ⤡ — is exactly one of these. See the
      // block comment on `settleDockedBackCards` for why this listener is the
      // one place the answer is still true.
      if (cameHome && isDockviewReturn(cardId)) noteCardCameHome(cardId);
      // hiding a popped-out card removes its panel, which closes the window —
      // that is US, not the user, and it must NOT suspend the session (E15-08)
      if (cardId && sessionStore.isHiding(cardId)) return;
      // ...and neither is a LADDER move (P2-E9-05), NOR EITHER ⤡ (E8-04,
      // #656). Moving a popped-out card into the grid to expand or stack it
      // takes its window down, which looks exactly like the user closing it —
      // and would suspend a session for a rung change. Since #656 both halves
      // of the dock-back button arm this flag as well, which is what replaced
      // E8-04's separate `markDockingBack`: one gesture, one mechanism, and
      // no flag left armed for a window that is going nowhere. Nothing marks
      // that flag any more, so it has gone from the store with it.
      if (cardId && sessionStore.isMoving(cardId)) return;
      if (cameHome) {
        // Nothing of ours is moving this card and it is out of its window: the
        // user closed it. Suspend, keeping the card and the record, so it
        // resumes when it is next looked at (E8-04).
        void window.switchboard.sessions.dropLive(cardId);
        sessionStore.forgetCardLiveIds(cardId);
        setLive(null);
        sessionStore.setPresentation(cardId, { suspended: true });
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
    setEnded(null);
    spawning.current = false;
  };
  const restartSelf = (): void => {
    // drop the dead live session (keep the card record), then re-arm the lazy
    // spawn so the card respawns/resumes
    //
    // Both halves under ONE `if (cardId)` (#239). They used to disagree: main
    // was told unconditionally while the renderer only unbound `if (live)`,
    // which admits the state where main has torn the session down and this
    // store still holds its binding, its grant and — since this issue — its
    // queued holds. `forgetCardLiveIds` is idempotent, so the guard bought
    // nothing, and `cardId ?? ''` was a sweep for a card that cannot exist.
    if (cardId) {
      void window.switchboard.sessions.dropLive(cardId);
      sessionStore.forgetCardLiveIds(cardId);
    }
    setEnded(null);
    setLive(null);
    spawning.current = false;
  };
  // One overlay, two truths (#355). `endedCopy` picks the words; the buttons are
  // the same two either way — `restartSelf` re-arms the lazy spawn, which is
  // "start it again" for a session that died and "try that again" for one that
  // never got going. `maxInlineSize` matches the suspended overlay: the
  // never-started line is a sentence, not a code.
  const overlayCopy = ended ? endedCopy(ended) : null;
  // ...and the one word the header above it wears (#606)
  const pill = ended ? endedPill(ended) : null;
  const endedOverlay = overlayCopy ? (
    // `card-overlay` (#358): the SEEN panel, as opposed to the card's live
    // region, which now holds the same words for the screen reader. A bare
    // `getByText('Session suspended')` matches both — an sr-only element is
    // 1×1 and clipped, which Playwright still counts as visible — so a spec
    // that means the panel has to say so. Same reason `view-tabs` carries one.
    <div data-testid="card-overlay">
      <div style={{ color: 'var(--text)', fontSize: 13, marginBlockEnd: 4 }}>{t(overlayCopy.heading)}</div>
      <div
        style={{ color: 'var(--muted)', fontSize: 11, marginBlockEnd: 12, maxInlineSize: 260 }}
      >
        {t(overlayCopy.detail, overlayCopy.detailVars)}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button onClick={restartSelf} style={overlayBtn(true)}>
          {t(overlayCopy.action)}
        </button>
        <button onClick={closeSelf} style={overlayBtn(false)}>
          {t('grid.close')}
        </button>
      </div>
    </div>
  ) : null;
  const suspendedOverlay = suspended ? (
    <div data-testid="card-overlay">
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
  // ...and what the card's live region says about whichever of them is up
  // (#358). Computed from the same three values the branch below switches on,
  // through the one function that knows their order.
  const said = overlaySaid({ live: !!live, suspended, ended });
  /**
   * §5.8's maximize, verbatim: "double-click a session header (or one command)
   * toggles maximize and restores the prior layout on repeat". The command is
   * the keyboard path — hiding chrome never removes capability, and a
   * double-click has none.
   *
   * Anything in the header that owns its own clicks keeps them: the task label
   * is click-to-edit and the buttons act on one press, so a second press there
   * is not a request to rearrange the workspace. Controls opt out by BEING one
   * (a button, a field) or by marking themselves — the marker is what covers
   * the click-to-edit task label, which is a plain span and would otherwise
   * depend on React having swapped its input in between the two clicks.
   *
   * One handler for both headers this card can draw (#216): the suspended one
   * has no controls to exempt today, and the exemptions are the part that must
   * not be re-derived if it ever grows one.
   */
  const maximizeOnDoubleClick = (e: React.MouseEvent): void => {
    const el = e.target as HTMLElement;
    if (el.closest('button, input, textarea, select, [data-no-maximize]')) return;
    if (cardId) toggleMaximizeCard(props.containerApi, cardId);
  };
  // ONE identity for whichever header is drawn (§5.11). The live session's copy
  // first — it is the record this card is bound to right now — and the card
  // record's copy under it, which is the one that still exists when the session
  // does not. They cannot disagree for long (main reuses `prior?.identity` on
  // every resume), but they DO differ for a frame or two: a card restored at
  // boot renders before the first `sessions:cards` push lands, and reading only
  // one of them there is a grey border that pops to the real accent in front of
  // the user.
  const headerAccent = live?.accent ?? cardAccent;
  const headerBadge = live?.badge ?? cardBadge;
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
    dockEpoch,
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
    approvalQueued: Math.max(0, cardQueue.length - 1),
    approvalBatched: permBatched,
    onDecide: decide,
    onCycleAutonomy: cycleCardAutonomy,
    setView,
  };
  const panels = listPanels(rendererRegistry);
  // is the find bar open on THIS card? (P2-E17-02) — published by the Ctrl+F
  // command, which runs in App's keydown handler and cannot reach this tree
  const findBar = React.useSyncExternalStore(subscribeFindBar, findBarState);
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
      {/* THE CARD'S ONE LIVE REGION (#358). Both overlays used to appear in
          silence — the panel is the whole message, and a user not sitting on
          this card was told nothing when a session died, refused to start, or
          suspended.

          `role="status"`, which is polite by definition and is how the rest of
          this app spells a live region (PreflightBanner, WorkspaceNoticeBanner,
          the rail's move notice). `aria-live="polite"` alongside it is strictly
          redundant and written anyway, belt-and-braces, exactly as EventsPanel's
          two notices do it — the attribute is the part a reader recognises, and
          the one thing this element must never quietly stop being is live.

          Polite and not `alert`/assertive: a card stopping is worth knowing and
          is not worth cutting across the sentence someone is in the middle of.

          The region is rendered HERE, unconditionally, rather than on the
          overlay's own container. That is the whole trick and it is not
          cosmetic: a live region INSERTED already holding its text is announced
          by almost nothing, and every overlay in this file mounts with its
          words in the same commit (a whole branch of the tree swaps). Putting
          the role on the overlay would look like a fix and announce nothing.
          The card root is the one element that outlives every branch, so a
          region parked here exists — empty — from the card's first frame, and
          the overlay's arrival is a text change INSIDE it, which is the
          mutation screen readers watch. `e2e/session.spec.ts` asserts that
          emptiness on a live card, which is the only assertion in the suite
          that fails if someone "tidies" this into `{said && <div …>}`.

          Deliberately NO one-commit `spoken` defer, unlike PreflightBanner. That
          trick exists to make a region announce state that was already true at
          mount; here that would be wrong. `suspended` comes off the store, so a
          restored card mounts already suspended — and eight restored cards
          announcing themselves at boot is noise, not news. Falling out of the
          plain read: a state that CHANGES while the card is up is announced, one
          that was already true when it mounted is not. `ended` starts null in
          every case, so it is always the first kind.

          It names the session first. With several cards up, "Session ended" on
          its own does not say whose — the same reason #196 named each card's
          conversation landmark. Three block children rather than one joined
          string: no ICU fragment-concatenation, and the reader gets a pause
          between the name, the heading and the sentence. Known and accepted:
          `role="status"` is atomic, so RENAMING a card while its panel is up
          re-reads the whole thing. Rare, harmless, and cheaper than memoising
          around it.

          The words are duplicated in the visible panel below, and that is
          accepted rather than papered over: `aria-hidden` on the panel's text
          would leave the overlay with NOTHING in the accessibility tree if this
          region ever regressed — strictly worse than today's bug. The buttons
          are not repeated here; they are focusable and announce themselves. */}
      <div role="status" aria-live="polite" data-testid="card-announcer" style={srOnly}>
        {said ? (
          <>
            <div>{headerTitle}</div>
            <div>{t(said.heading)}</div>
            <div>{t(said.detail, said.detailVars)}</div>
          </>
        ) : null}
      </div>
      {live ? (
        <div style={cardColumn}>
          {/* card header (.chead) — accent border, identity, status, window controls */}
          <div
            data-testid="card-header"
            title={t('layout.maximizeHint')}
            onDoubleClick={maximizeOnDoubleClick}
            style={cheadStyle(headerAccent)}
          >
            {/* the SAME badge the tab above draws (#269) — §5.11's "renders
                identically everywhere", and the accent is the field, never the
                ink: as 9px text it measured 1.80-3.11:1 on daylight */}
            {headerBadge && (
              <span data-testid="identity-badge" style={identityBadgeStyle(headerAccent)}>
                {headerBadge}
              </span>
            )}
            <span data-testid="card-header-name" style={cheadName}>
              {headerTitle}
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
                // A stable handle: the label's TEXT is the thing under test in
                // e2e/task-label.spec.ts, and §5.11 has it render in the rail
                // as well — so locating it by its words finds two elements.
                data-testid="card-task-label"
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
                title={autonomyTooltip(t, live.autonomy, 'badge')}
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
            {/* #531. ONLY while this card is out in its own window: the main
                window has `+ session` in its own chrome, and a second ⊕ on
                every card header there would be clutter offering nothing new.
                A popout has no chrome of ours at all — dockview adopts the
                group's DOM into an otherwise empty document — so the card
                header is the only surface in that window we can put it on.

                It names its OWN group rather than asking which window has
                focus: a click IS the answer to "where", and inferring it back
                from focus would be strictly worse information. */}
            {poppedOut && (
              <>
                {/* The error rides WITH the ＋, inside the same guard: dock the
                    card back and this header is in the main window, where the
                    grid's own banner is the right surface and a leftover line
                    about a folder you picked in another window is noise. */}
                {cardError && (
                  <span
                    role="status"
                    data-testid="card-new-session-error"
                    style={{ color: 'var(--status-crashed-ink)', fontSize: 10 }}
                  >
                    {cardError}
                  </span>
                )}
                <button
                  data-testid="card-new-session"
                  onClick={() => {
                    setCardError(null); // a retry starts clean
                    void newSessionIn(props.containerApi, props.api.group, setCardError);
                  }}
                  title={t('grid.newSessionHere')}
                  aria-label={t('grid.newSessionHere')}
                  style={cheadBtn}
                >
                  {t('grid.newSessionHereIcon')}
                </button>
              </>
            )}
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
                    {/* session controls send the REAL slash command to the
                        session, on whichever transport it is on (#381 — they
                        went straight to the PTY before, and did nothing at all
                        in Direct mode). Locked while 'starting' — the CLI may
                        still be in a startup TUI dialog the composer can't see
                        (§5.10 startup-dialog rule) — and once the session is
                        dead (crashed/exited): the send would be a silent no-op.
                        'done' stays live — the session is idle, not gone. */}
                    {confirmClear && !controlsLocked ? (
                      <div style={{ padding: '4px 8px' }}>
                        <div style={{ color: 'var(--text)', marginBlockEnd: 6 }}>
                          {t('grid.menuClearConfirm')}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => {
                              void sendSessionCommand(live.id, '/clear');
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
                        {/* A STATEFUL entry, not a command — a screen reader
                            has to be told this one has an on/off, and the box
                            glyph is the same fact for everyone else (never
                            color alone, §5.32).

                            `aria-pressed`, NOT `menuitemcheckbox`, and the
                            difference is the container: this dropdown is a
                            plain div of buttons with only Escape on it. A
                            `menuitemcheckbox` is only valid when a `role=menu`
                            OWNS it, and in this codebase a `role=menu` is a
                            promise of roving arrow keys the rail's menu keeps
                            (#197) and this one does not — claiming the role
                            here would announce a menu that the arrows then
                            refuse to walk. A toggle button is valid in any
                            container and carries the same state. Promoting
                            this whole menu to a real APG menu is worth doing,
                            but it is a menu-wide job, not this checkbox's.

                            Not locked with the session controls above: those
                            type a slash command into a live CLI, this writes a
                            preference, and a suspended or crashed card is
                            exactly when you want to arm it. */}
                        {rulesApi && (
                          <button
                            aria-pressed={notifyWhenDone}
                            data-testid="card-notify-when-done"
                            onClick={toggleNotifyWhenDone}
                            title={t('grid.menuNotifyWhenDoneHint')}
                            style={menuItemStyle(false)}
                          >
                            <span aria-hidden="true" style={{ marginInlineEnd: 6 }}>
                              {notifyWhenDone ? t('grid.checkedIcon') : t('grid.uncheckedIcon')}
                            </span>
                            {t('grid.menuNotifyWhenDone')}
                          </button>
                        )}
                        {/* This card's sound (P2-E14-05a). A COMMAND, not a
                            toggle — it has eight states, not two — so it says
                            what it is now and what clicking does, the lesson
                            #153 taught the transport entry two items up. */}
                        {soundsApi && cardSound && (
                          <button
                            data-testid="card-sound"
                            onClick={cycleSound}
                            title={t('grid.menuSoundHint')}
                            style={menuItemStyle(false)}
                          >
                            {t('grid.menuSound', {
                              // "Automatic (Knock)" while nobody has chosen —
                              // naming the cue you will actually hear, because
                              // "Automatic" alone answers the wrong question.
                              now: cardSound.pinned
                                ? t(`sounds.${cardSound.id}`)
                                : t('sounds.autoNow', { name: t(`sounds.${cardSound.id}`) }),
                              next: soundName(nextCardSound(cardSound)),
                            })}
                          </button>
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
                            void sendSessionCommand(live.id, '/compact');
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
                if (!e.currentTarget.contains(e.relatedTarget)) setTabFocus(null);
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
            {/* Session find (P2-E17-02, §5.31). It lives in THIS card, over
                THIS card's active panel — which is what makes "Ctrl+F never
                matches text in another session" a fact about the wiring
                rather than a filter someone has to maintain. Absolutely
                positioned inside this already-relative box, so opening it
                moves nothing underneath. */}
            {findBar.openOn === cardId && active && (
              <FindBar
                sessionId={live.id}
                cardId={cardId}
                panelId={active.id}
                panelTitleKey={active.titleKey}
              />
            )}
            {endedOverlay && <div style={overlayBackdrop}>{endedOverlay}</div>}
          </div>
        </div>
      ) : suspended ? (
        <div style={cardColumn}>
          {/* THE SUSPENDED CARD'S HEADER (#216). A restored-not-yet-resumed
              session drew no header at all, so §5.8's "double-click a session
              header toggles maximize" had nothing to land on — the one gesture
              in the ladder that a suspended card could not be given, while the
              binding and the palette command worked on it the whole time. The
              manual had to write that exception down; this is the exception
              going away.

              The SUSPENDED-APPROPRIATE SUBSET of the live header, and nothing
              else: identity (accent, badge, name — §5.11's one identity), the
              state in a word, and the maximize gesture. Deliberately NOT the
              controls: the collapse/pop-out/⋯ buttons act on a running session,
              and the two things this card genuinely offers — Resume and Close —
              are already the overlay's own buttons, two centimetres below.
              Repeating them in the header would be a second way to do the same
              thing on the smallest surface the card has.

              The pill says `suspended` from the branch rather than from the
              status state, which is still whatever the session last reported
              (or `starting`, for a card restored this launch). Same token the
              rail row and the urgency lamp use for this card right now —
              presentStatus is the one vocabulary, so the card cannot look like
              two different states in two places. */}
          <div
            data-testid="card-header"
            title={t('layout.maximizeHint')}
            onDoubleClick={maximizeOnDoubleClick}
            style={cheadStyle(headerAccent)}
          >
            {headerBadge && (
              <span data-testid="identity-badge" style={identityBadgeStyle(headerAccent)}>
                {headerBadge}
              </span>
            )}
            <span data-testid="card-header-name" style={cheadName}>
              {headerTitle}
            </span>
            <span style={{ flex: 1, minInlineSize: 8 }} />
            <StatusPill status="suspended" label={t('status.suspended')} />
          </div>
          <div style={{ ...overlayBackdrop, position: 'relative', flex: 1 }}>{suspendedOverlay}</div>
        </div>
      ) : ended ? (
        // spawn/resume failed before a terminal existed — still recoverable, and
        // this is the branch a never-started card lands on (#355)
        <div style={cardColumn}>
          {/* THE ENDED CARD'S HEADER (#606) — the last card state that drew
              none, and the same gap #216 closed for suspended.

              WHICH CARD THIS IS, precisely: one whose session NEVER STARTED.
              A session that ran and then died keeps its record (`onExited`
              sets `ended` and leaves `live` alone, on purpose), so it renders
              through the live arm above with the header it always had. This arm
              is the `live === null && ended` one, and until now it drew the
              overlay and nothing else — so §5.8's "double-click a session header
              toggles maximize" had no target on it, while `Ctrl+Shift+M` and the
              palette command worked on it the whole time. A gesture that works
              from the keyboard and not from the mouse, on one card state out of
              four, is exactly the kind of exception the manual ends up writing
              down.

              WHAT THE GESTURE CAN AND CANNOT DO HERE, so nobody reads more
              into this than it gives: the double-click reaches
              `toggleMaximizeCard` and the maximize is recorded, but the SWEEP
              declines it, because `lib/layout-mode`'s `heldMaximize` honours a
              maximize only for a card the session list still holds — and a card
              whose `sessions:create` was refused was never registered as one.
              It has no rail row either. That is older than this header and true
              of `Ctrl+Shift+M` on the same card today; it is reported on #606's
              PR rather than fixed here, because widening it is a lifecycle
              change (does a refused card exist?) and not a header.

              Deliberately the SAME subset as the suspended header, through the
              same three module-scope pieces (`cheadStyle`, `cheadName`,
              `maximizeOnDoubleClick`): identity, the state in a word, and the
              maximize target — and no controls. Restart/Try again and Close are
              the overlay's own buttons a couple of centimetres below, and a
              header copy of them would be a second way to do the same thing on
              the smallest surface the card has. */}
          <div
            data-testid="card-header"
            title={t('layout.maximizeHint')}
            onDoubleClick={maximizeOnDoubleClick}
            style={cheadStyle(headerAccent)}
          >
            {headerBadge && (
              <span data-testid="identity-badge" style={identityBadgeStyle(headerAccent)}>
                {headerBadge}
              </span>
            )}
            <span data-testid="card-header-name" style={cheadName}>
              {headerTitle}
            </span>
            <span style={{ flex: 1, minInlineSize: 8 }} />
            {pill && <StatusPill status={pill.status} label={t(pill.labelKey)} />}
          </div>
          <div style={{ ...overlayBackdrop, position: 'relative', flex: 1 }}>{endedOverlay}</div>
        </div>
      ) : (
        <span style={{ margin: 'auto' }}>
          {t('grid.resuming', { title: headerTitle })}
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

/**
 * The card header row (.chead) — accent border, identity, status.
 *
 * A function at module scope rather than an object literal inside the render
 * because a card has THREE headers to draw (#216, #606): the live one, with its
 * window controls, and the suspended and ended ones, which are the same row
 * minus every control that would act on a session that is not running. §5.11's "one identity,
 * rendered identically everywhere" is a promise about pixels, and the way that
 * promise rots is a second copy of the row drifting from the first.
 *
 * The accent is a parameter because it comes from two places: the live session
 * record while there is one, and the card record in the store while there is
 * not. Same field (`identity.accentColor`), two routes to it.
 */
function cheadStyle(accent?: string): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    paddingInline: 10,
    paddingBlock: 7,
    borderBlockEnd: '1px solid var(--border)',
    borderInlineStart: `3px solid ${accent ?? 'var(--faint)'}`,
    background: 'var(--panel2)',
  };
}

/** The column a card's header and body share — all three branches that draw a
 *  header (live, #216's suspended one, #606's ended one) are this box. */
const cardColumn: React.CSSProperties = {
  flex: 1,
  minInlineSize: 0,
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
};

/** The session name in a card header. */
const cheadName: React.CSSProperties = {
  fontWeight: 650,
  fontSize: 13,
  color: 'var(--text)',
  fontFamily: 'var(--font-ui)',
  whiteSpace: 'nowrap',
  // #294. `nowrap` alone made the row a promise it could not keep: a flex
  // item's automatic minimum size is its own content until its inline-axis
  // `overflow` stops being `visible` (CSS Sizing 3 §5.2), so a 120-character
  // title — main's cap — grew the header past its card and carried the status
  // pill and the window buttons off the end with it. The controls, not the
  // name, were what got lost. Measured, not assumed: with these two the header
  // overflows its card by 0px; without them, by 1170px at a 1280-wide window.
  // This is the pair IdentityChip and the rail rows already truncate with — no
  // `min-inline-size` needed, and none used there either.
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

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

/* The card's overlay announcer is invisible rather than absent (#358). The
   declarations moved to `./sr-only` when P2-E14-01 became the third copy, which
   is what #367 said would happen. */

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
      // FROM THE PANEL ID, not a new param. `openDiff` already encodes the card
      // in `diff-<cardId>` and reading it back costs nothing, where threading a
      // `cardId` param would edit the one function another item is currently
      // holding — and would leave every Changes tab already in a restored
      // layout without it. The id is the fact; the param would be a copy.
      sessionId={/^diff-(.+)$/.exec(props.api.id)?.[1]}
    />
  );
}

/**
 * The §5.30 document viewer as a dockview panel (P2-E16-02).
 *
 * A DERIVED panel like `diffPane` — no `cardId`, so `IdentityTab` falls back to
 * the dockview title and the store never tries to rename it. Its params are the
 * file path and the colour scheme, both primitives, because params are frozen
 * into the layout blob.
 *
 * The tab title follows relative-link navigation: `onTitleChange` calls
 * dockview's `setTitle`, which is the one place a panel's title is allowed to
 * move after `addPanel`.
 */
/** A viewer's tab says the file's name; the panel's own header says the path. */
function documentTabTitle(filePath: string): string {
  return baseName(filePath) || filePath;
}

/**
 * Is this group the document area — does a viewer live in it?
 *
 * Named once and read from both sides of the same sentence: a viewer PREFERS
 * this group (there is one document area, not one per file), and a session card
 * REFUSES it (#462, the mirror rule). One predicate so the two answers cannot
 * drift apart — not one policy: which of them wants a `true` here is the whole
 * difference between them.
 */
const isDocumentArea = (g: DockviewGroupPanel): boolean =>
  g.panels.some((p) => p.id.startsWith('doc-'));

/**
 * The DOCUMENT AREA: the group a viewer may open into (§5.30, P2-E16-03).
 *
 * "A viewer never displaces a session. It opens into the document area or its
 * own window — never as a tab inside a session's group." Two ways to break that
 * rule, and this closes both:
 *
 *  1. THE POPOUT. dockview's `addPanel` defaults to the ACTIVE group, which
 *     becomes a popout the moment a card is torn off — so a file opened while a
 *     popped-out session had focus would land as a tab inside that session's
 *     window. That is the E8-04 defect in mirror image, and it now has a second
 *     face: once a VIEWER can have its own window, that viewer's popout is just
 *     as wrong a home for the next one. Only `grid` groups are considered, so
 *     both are excluded by the same line.
 *  2. THE SESSION'S GROUP. P2-E16-02 took the first grid group, which with one
 *     session open IS that session's group — the viewer arrived as a tab beside
 *     the card, and switching to it hid the session. Group membership is the
 *     test, not group count, and a Changes tab counts: pop a card out of a
 *     group that also holds its `diff-` tab and only the card moves, leaving a
 *     group that has no `session-` panel in it and is still, unmistakably, that
 *     session's — dockview merges the card straight back into it on dock-back.
 *
 *  3. THE INVISIBLE PLACEHOLDER, which is the one that costs an hour. Popping
 *     out a panel that is ALONE in its group leaves the original group in the
 *     grid, EMPTY and `setVisible(false)`, because that shell is how the group
 *     docks back later (dockview's `_doAddPopoutGroup`). It is a grid group
 *     with no session panel and no doc panel, so it matches every predicate
 *     above — and `addPanel` does not un-hide it. The viewer would be in the
 *     DOM, in the layout, and 0px tall. `isVisible` is the whole fix; nothing
 *     else in this app hides a grid group.
 *
 * Preference order: the group already holding viewers (there IS one document
 * area, not one per file), then any other eligible group, then a new one —
 * which is what puts the document area on screen the first time, beside the
 * sessions rather than over them.
 *
 * `openDiff` does not go through this, and SHOULD NOT — a Changes tab is a
 * session's own surface. It routes through `gridRefGroup` (#434) instead,
 * which is the same E8-04 rule with the opposite husk policy: a diff may
 * revive a session's dock-back husk (it IS that session's surface); a viewer
 * never does (the husk is still, unmistakably, a session's group).
 */
function documentHomeGroup(api: DockviewApi): DockviewGroupPanel {
  const eligible = api.groups.filter(
    (g) =>
      g.api.location.type === 'grid' &&
      g.api.isVisible &&
      // A session's own panels, both kinds. The preference below applies the
      // same predicate, so a viewer dragged into a session's group by hand
      // never turns that group into the permanent document area.
      !g.panels.some((p) => /^(session|diff)-/.test(p.id))
  );
  const existing = eligible.find(isDocumentArea) ?? eligible[0];
  if (existing) return existing;
  // NOTHING TO OPEN INTO, so one is made — and WHERE is the whole of #569.
  //
  // `api.addGroup()` with no argument puts the new group wherever dockview
  // pleases, which is how a file opened from a session on the left could arrive
  // somewhere the user was not looking. The owner's ask: "it opens into the same
  // doc area as the active session, just the doc section it's in… like you would
  // if you opened another new session in that dock section."
  //
  // So: BESIDE the active session's group, splitting that region — not inside
  // it. §5.30's rule survives intact and is the reason for the `direction`
  // rather than a `referenceGroup` tab: "a viewer never displaces a session. It
  // opens into the document area or its own window — never as a tab inside a
  // session's group." Next to it on screen, and never in its tab strip.
  const beside = activeSessionGroup(api);
  return beside ? api.addGroup({ referenceGroup: beside, direction: 'right' }) : api.addGroup();
}

/**
 * The grid group holding the session the user is actually looking at (#569).
 *
 * `api.activeGroup` is the authority on focus, but it answers for popouts too —
 * and a group in another OS window is not a place to split a document into, so
 * the grid check stays. A group with no session panels is not a session either;
 * the caller has already preferred those, so reaching here with one means the
 * user's focus is somewhere that tells us nothing about where a document
 * belongs, and `null` lets dockview choose as it always did.
 */
function activeSessionGroup(api: DockviewApi): DockviewGroupPanel | null {
  const active = api.activeGroup;
  if (
    active &&
    active.api.location.type === 'grid' &&
    active.api.isVisible &&
    active.panels.some((p) => /^session-/.test(p.id))
  ) {
    return active;
  }
  // No active session — the owner's words were "its own little dock section…
  // or just the first dock section, it doesn't matter to me". The first VISIBLE
  // session's group is the nearest thing to "where the work is", and falling
  // through to null (dockview's own choice) is the honest answer when there is
  // no session at all. NOTE "first" is dockview's INSERTION order, not
  // left-to-right: after a drag it can be the rightmost group on screen. Fine
  // for a fallback nobody asked to be precise about — but it is not a spatial
  // claim, and reading it as one would be wrong.
  return (
    api.groups.find(
      (g) =>
        g.api.location.type === 'grid' &&
        g.api.isVisible &&
        g.panels.some((p) => /^session-/.test(p.id))
    ) ?? null
  );
}

/**
 * The group a panel that belongs in the MAIN WINDOW must be added to — the
 * E8-04 rule in one place (#434, extended by #462).
 *
 * dockview's `addPanel` defaults to the ACTIVE group, and the active group
 * becomes a popout the moment a card is torn off — so a panel opened while a
 * popped-out session had focus lands as a tab inside that session's OS window,
 * where the user never asked for it and cannot find it. Pin it to a group the
 * user can actually see in the main grid instead — reviving or making one when
 * there is none.
 *
 * `eligible` narrows WHICH grid groups will do, and is the only thing that
 * differs between the callers: a Changes tab takes any of them (it is a
 * session's own surface), a session card refuses the document area and — while
 * a viewer is out in its own window — every empty shell with it (#462). It
 * filters the husk fallback too, on purpose: that is the ONLY line the second
 * of those rules can act on, since a shell has no panels to recognise it by.
 */
function gridRefGroup(
  api: DockviewApi,
  eligible: (g: DockviewGroupPanel) => boolean = () => true
): DockviewApi['groups'][number] {
  const candidates = api.groups.filter((g) => g.api.location.type === 'grid' && eligible(g));
  const visible = candidates.find((g) => g.api.isVisible);
  if (visible) return visible;
  // Nothing VISIBLE is left in the grid, which is not the same as nothing being
  // left in it. We pop a CARD out, not a whole group, and dockview's answer to
  // that is to move the panel into a window and keep the group it came from —
  // in the grid, still `location.type === 'grid'`, but hidden
  // (`_doAddPopoutGroup`: `referenceGroup.api.setVisible(false)`), so the card
  // has a slot to come home to. Its leaf is `width: 0px`, and a panel added to
  // it is in the DOM, on the right window, and invisible — measured (#434), and
  // exactly what a `location`-only test walks into. Show the husk again rather
  // than adding a group beside it: it holds the geometry the card used to
  // occupy, and the card rejoins it as a sibling tab when it docks back.
  const husk = candidates[0];
  if (husk) {
    husk.api.setVisible(true);
    return husk;
  }
  return api.addGroup();
}

/**
 * Where a NEW OR RETURNING SESSION CARD lands (#462) — `gridRefGroup` plus the
 * mirror of the viewer's invariant.
 *
 * Two rules, and a card breaks both the same way. dockview's `addPanel`
 * defaults to the ACTIVE group, so:
 *
 *  * MAIN WINDOW, VISIBLY. Not a tab inside whatever popout is active, and not
 *    the hidden dock-back shell a popout leaves behind in the grid — that husk
 *    still reports `location.type === 'grid'`, so the location-only lookup this
 *    replaces would put a brand new session in a 0px leaf. Measured at 1.33px
 *    on the viewer side of the same bug (#434, #411); `toBeVisible()` passes
 *    there, which is why the e2e measures width. Reviving the husk is right for
 *    a card in a way it is not for a viewer: the husk IS a session's slot, it
 *    holds the geometry the popped-out card used to occupy, and that card
 *    rejoins as a sibling tab when it docks back.
 *  * NOT THE DOCUMENT AREA. "A viewer never displaces a session" (§5.30) has an
 *    obverse the day the document area became real (P2-E16-02/03): a session
 *    must not displace what you are reading either. Without this the card would
 *    open as a tab over the viewer — because with every card popped out, the
 *    document area is the only VISIBLE grid group left, and #434's picker would
 *    hand it straight over.
 *
 * ...and the two rules meet in the husk, which is why the second one cannot be
 * `isDocumentArea` alone: a shell is EMPTY by construction, so nothing about it
 * says whether the panel that left was a card or a viewer. Revive a VIEWER's
 * shell and the card takes the document area by the back door — and dockview
 * hands the viewer back into that same group when its window closes, i.e. as a
 * tab beside the card. dockview does not expose which group a popout will
 * return to, so the honest question is the coarse one: while a viewer is out in
 * its own window, refuse every shell and pay for a fresh group instead.
 *
 * `exclude` is one group this card may NOT be sent to, and it has exactly one
 * caller: the settle that re-places a card dockview has already dropped into a
 * slot it never earned (#657). Without it the answer would be the group the
 * card is standing in — dockview un-hides the dock-back husk on the way in
 * (`disposePopoutWindow`), so by the time we look, the wrong slot is a visible
 * grid group holding this very card, and "the first visible grid group" would
 * hand it straight back.
 */
function sessionCardHome(
  api: DockviewApi,
  exclude?: DockviewApi['groups'][number] | null
): DockviewApi['groups'][number] {
  const viewerIsOut = viewerIsPoppedOut(api);
  return gridRefGroup(
    api,
    (g) => g !== exclude && !isDocumentArea(g) && !(viewerIsOut && g.panels.length === 0)
  );
}

/**
 * The live grid group a remembered slot names, or `undefined` (#502).
 *
 * `homeGroupId` is the RULE and is pure — gone, popped out, or become the
 * document area all mean "not a slot any more"; an invisible grid group does
 * NOT, because that is the dock-back husk the card itself left behind and it
 * still holds the geometry. This is only the dockview half: the id resolved
 * back to a group.
 *
 * Shared by the two gestures that place a card from a record — ⤡ reading
 * `home` (#558) and the ladder reading `slot` (#502) — so the husk and
 * document-area rules cannot drift apart again. They were separate copies, and
 * one of them was missing both.
 */
function slotGroup(
  api: DockviewApi,
  slot: SlotRef | null | undefined
): DockviewApi['groups'][number] | undefined {
  const id = homeGroupId(
    slot,
    api.groups.map((g) => ({
      id: g.id,
      location: g.api.location.type,
      hasDocument: isDocumentArea(g),
    }))
  );
  return id ? api.groups.find((g) => g.id === id) : undefined;
}

/** Is a document viewer out in its own OS window? Named once because two
 *  placements refuse an empty shell on the strength of it — see the paragraph
 *  above about why the question has to be this coarse. */
function viewerIsPoppedOut(api: DockviewApi): boolean {
  return api.panels.some(
    (p) => p.id.startsWith('doc-') && p.group.api.location.type === 'popout'
  );
}

/**
 * Where a card DOCKING BACK from a popout lands (#558).
 *
 * Its own slot when it still has one, and `sessionCardHome`'s ordinary rules
 * when it does not — the second half being the whole of the owner's bug. A
 * popout window carries ONE dock-back reference, the group it was torn from,
 * and every card in it inherits that on the way home. The card born inside the
 * window (#531) never had a slot in the grid, so it was handed its opener's:
 * the opener came home to whatever group was visible, and the newcomer took the
 * half of the screen the opener used to own.
 *
 * `homeGroupId` is the decision and is pure; the dockview verbs are here.
 * The `setVisible` is the same husk revival `gridRefGroup` does and for the
 * same reason: a card's slot survives its absence as an empty hidden group with
 * the geometry still on it, and landing in one without un-hiding it puts the
 * card in the DOM, in the right window, and 0px wide (#434). `revived` is
 * reported back so a move that then fails can put the shell away again rather
 * than leaving an empty pane on screen.
 *
 * A NAMED SLOT DOES NOT BEAT THE VIEWER RULE, which is the one place this could
 * quietly undo #462. `sessionCardHome` refuses EVERY empty shell while a viewer
 * is out in its own window, because a shell is empty by construction and
 * nothing about it says whether a card or a viewer left it — and dockview hands
 * that viewer back into the same group when its window closes. A card's claim
 * on its own slot says nothing about that, since the two can have shared a
 * group; so the coarse rule is applied here too and the card pays for a group
 * of its own until the viewer is home.
 *
 * `exclude` is passed straight to `sessionCardHome` and is documented there: it
 * is the settle's way of saying "anywhere but the slot you were just dropped
 * into" (#657). It deliberately does NOT disqualify the card's own `home` —
 * a card whose home IS where it landed never reaches this function.
 *
 * `home` IS PASSED IN rather than read from the store, and that is not tidiness.
 * One caller asks before the card has moved and one asks after, and after is too
 * late to read the record: `captureSlots` runs on the layout change dockview's
 * own return fires, sees the card sitting in a real grid group, and banks that
 * group as its home — the very slot it did not earn. See `noteCardCameHome`.
 */
function dockBackTarget(
  api: DockviewApi,
  home: SlotRef | null,
  exclude?: DockviewApi['groups'][number] | null
): { group: DockviewApi['groups'][number]; index: number; revived: boolean } {
  const group = slotGroup(api, home);
  if (!group || (group.panels.length === 0 && viewerIsPoppedOut(api))) {
    return { group: sessionCardHome(api, exclude), index: -1, revived: false };
  }
  const revived = !group.api.isVisible;
  if (revived) group.api.setVisible(true);
  return { group, index: home?.index ?? -1, revived };
}

/**
 * The popped-out group whose OS window has focus, or null (#531).
 *
 * The rule is `lib/new-session-target`'s and is unit-pinned there; this is the
 * dockview half — asking each popout group's own Window whether the OS is
 * pointing at it. `hasFocus()` and not `api.activeGroup`, for the reason that
 * module's header gives: a group can be dockview-active while its window sits
 * behind three others, and #434 is precisely the bug of trusting that.
 */
function focusedPopoutGroup(api: DockviewApi): DockviewApi['groups'][number] | null {
  const shapes = api.groups.map((g) => {
    const loc = g.api.location;
    let focused = false;
    if (loc.type === 'popout') {
      try {
        focused = loc.getWindow()?.document?.hasFocus() === true;
      } catch {
        // a window closing under us — fail open, it simply is not the target
      }
    }
    return { id: g.id, isPopout: loc.type === 'popout', focused, group: g };
  });
  return newSessionHostGroup(shapes)?.group ?? null;
}

/**
 * Create a session in `folder` and add its card.
 *
 * Module-level, like `popOutCardPanel` and `setCardLadder`, and for the same
 * reason: three surfaces drive it now — the `+ session` button, the palette,
 * and (since #531) a popped-out card's own header — and a `useCallback` closed
 * over the component cannot be reached from a panel that dockview renders.
 *
 * `into` is an EXPLICIT destination group and beats every inference below it.
 * That is #531: a card asked for from inside a popped-out window lands as a
 * tab in that window. Everything else still goes through `sessionCardHome`,
 * which is #434/#462's rule and stays exactly as strict as it was — the
 * difference is that this destination was NAMED, not guessed from whichever
 * group dockview happened to have activated.
 */
async function addSessionCardTo(
  api: DockviewApi | null,
  folder: string,
  opts: { groupId?: string; into?: DockviewApi['groups'][number] | null } = {}
): Promise<void> {
  if (!api) return;
  const { groupId, into } = opts;
  const title = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder;
  const cardId = crypto.randomUUID();
  // A persistent-group member clusters with its siblings (E12-02): reuse the
  // dockview group already holding another member, when one is in the grid.
  let sibling: DockviewApi['groups'][number] | undefined;
  if (groupId && !into) {
    // #650: no card list means no siblings to cluster with, so the new card
    // lands in the grid the ordinary way. `.filter` on the brand would throw
    // and lose the card entirely, which is the opposite of fail-open.
    const cards = answered(await window.switchboard.sessions.cards()) ?? [];
    const siblings = new Set(
      cards.filter((c) => c.groupId === groupId).map((c) => `session-${c.cardId}`)
    );
    // `isVisible` for the husk reason below — clustering is a reason to land
    // BESIDE a sibling, never a reason to land somewhere invisible. The
    // document-area rule is deliberately NOT applied here: a group holding a
    // group-mate is a session's group whatever else was dragged into it, and
    // an explicit group membership is the stronger of the two user intents.
    sibling = api.panels.find(
      (p) => siblings.has(p.id) && p.group.api.location.type === 'grid' && p.group.api.isVisible
    )?.group;
  }
  // A new session must land in the MAIN window, visibly, and not on top of the
  // document you are reading — `sessionCardHome` is all three rules (E8-04,
  // #462). It used to be a location-only `find`, which is blind to the hidden
  // dock-back husk a popout leaves in the grid.
  //
  // Asked LAST, and only when the sibling lookup came up empty, because it is
  // not a pure question: it can un-hide a group or mint one. Asked first (as
  // the `find(...) ?? addGroup()` it replaces was) a sibling win would leave
  // that brand new group behind in the grid, empty, for ever.
  const refGroup = into ?? sibling ?? sessionCardHome(api);
  api.addPanel({
    id: `session-${cardId}`,
    component: 'sessionCard',
    title,
    params: { cardId, folder, title, groupId } satisfies CardParams,
    // NO `direction` — `within` (the default) is the only target dockview
    // resolves against the reference group itself. Any of the four directions
    // sends it through `getGridLocation(referenceGroup.element)` against the
    // MAIN gridview, and a popout group's element is not in that grid
    // (dockviewComponent.js `addPanel`, the `center` branch vs the rest).
    position: { referenceGroup: refGroup },
  });
}

/**
 * Move an existing card's PANEL next to its persistent-group siblings (E12-04),
 * after a rail drop has already written the membership.
 *
 * Module-level, like `popOutCardPanel` and `setCardLadder`, and for the same
 * reason the file gives them: every imperative verb here takes the api, so it
 * can be driven from a command, from a panel dockview renders, and from a test
 * — a closure inside the controller effect can be reached from none of those.
 *
 * IT IS `addSessionCardTo`'S SIBLING LOOKUP, ONE PATH OVER, and #503 is the
 * story of the two copies disagreeing: #501 hardened that one and left this one
 * as it was. They now say the same thing in the same words. Two rules, and the
 * ORDER of them is the second half:
 *
 *  * a sibling's group must be VISIBLE as well as in the grid. Clustering is a
 *    reason to land BESIDE a group-mate, never a reason to land somewhere
 *    invisible — and a grid group can be invisible two ways `location` alone
 *    cannot see: the dock-back husk a popout leaves behind (#434/#462), and
 *    every other group while one is maximised (E9-07).
 *  * NO `sessionCardHome` FALLBACK. `addSessionCardTo` asks for one only AFTER
 *    this lookup fails, because it is not a pure question — it can un-hide a
 *    group or MINT one, and a group minted before a sibling wins is left in the
 *    grid, empty, for ever. Here there is nothing to fall back to at all: no
 *    group-mate on screen means the panel stays exactly where the user left it,
 *    which is the behaviour this has always had and the reason it cannot leak.
 *
 * `groupId` of `null` is UNGROUPING, and does nothing: taking a card out of a
 * group is not a reason to move it off the screen it is on.
 */
export async function clusterCardWithGroup(
  api: DockviewApi | null,
  cardId: string,
  groupId: string | null
): Promise<void> {
  if (!api || !groupId) return;
  const panel = api.getPanel(`session-${cardId}`);
  if (!panel) return;
  // #650: no card list means no siblings, so the panel stays where it sits —
  // which is what this whole function already does when it finds none.
  const cards = answered(await window.switchboard.sessions.cards()) ?? [];
  const siblings = new Set(
    cards
      .filter((c) => c.groupId === groupId && c.cardId !== cardId)
      .map((c) => `session-${c.cardId}`)
  );
  const sibling = api.panels.find(
    (p) => siblings.has(p.id) && p.group.api.location.type === 'grid' && p.group.api.isVisible
  );
  if (!sibling || sibling.group === panel.group) return;
  // OUR move, not a user drag (see setMoving). The rail drop has ALREADY
  // written the membership; letting E12-04 adopt from the destination would let
  // a group-mate's neighbours overwrite the group the user just chose.
  sessionStore.setMoving(cardId, true);
  try {
    panel.api.moveTo({ group: sibling.group });
  } finally {
    sessionStore.setMoving(cardId, false);
  }
}

/**
 * The whole ⊕ gesture: pick a folder, then put the card somewhere (#531).
 *
 * `into` is the window the ASK came from — a popped-out card's own group, or
 * null for the main window. It is used twice and both matter: it places the
 * card, and it parents the folder dialog. A dialog parented to the main window
 * while the user is working in a popout yanks the whole app forward and
 * answers a question they asked somewhere else.
 */
async function newSessionIn(
  api: DockviewApi | null,
  into: DockviewApi['groups'][number] | null,
  onError: (message: string) => void
): Promise<void> {
  if (!api) return;
  try {
    // INSIDE the try, unlike the `addCard` this replaces: both call sites drive
    // this with `void`, so a rejection out here was an unhandled rejection
    // rather than a message anyone saw.
    // `answered` (#440): a refused picker resolves a truthy object, which would
    // reach `addSessionCardTo` as the folder path.
    const folder = answered(await window.switchboard.sessions.pickFolder(into?.id));
    if (!folder) return;
    // `into` was sampled BEFORE the picker opened, and a group can die while it
    // is up: the dialog is modal to that popout, so the user cannot close it
    // from there, but a command or a layout mode driven from the main window
    // can dock the card back and dispose the group under us. A disposed group
    // is not a destination — fall through to the grid's own placement rules
    // rather than handing `addPanel` a corpse.
    const stillOpen = into && api.groups.includes(into) ? into : null;
    await addSessionCardTo(api, folder, { into: stillOpen });
  } catch (e) {
    // our breakage must be visible, not mute (fail-open)
    onError(String(e));
  }
}

/**
 * Open a document viewer on `filePath` — a NEW TAB every time (#530, §5.30).
 *
 * A module-level function taking the api, like every other imperative verb in
 * this file, so the scripted-check seam in `onReady` can call the same code the
 * controller does — through the controller it would race the effect that
 * installs it.
 *
 * The DECISION (focus / create) is `lib/document-panels`'; this is only the
 * dockview half of it, and since #530 removed the peek slot the dockview half
 * is a `focus` or an `addPanel` and nothing else. No panel is ever re-pointed,
 * so a viewer shows one document for its whole life and closes by its own ✕.
 * `documentHomeGroup` is what makes the new tab land BESIDE the ones already
 * open rather than in a group of its own each time.
 */
function openDocumentPanel(
  api: DockviewApi | null,
  filePath: string,
  colorScheme: 'light' | 'dark',
  sessionId?: string
): void {
  if (!api || !filePath) return;
  const plan = planDocumentOpen(filePath, sessionId);
  if (plan.action === 'focus') {
    const panel = api.getPanel(plan.id);
    if (panel) {
      panel.focus();
      // ...AND RAISE THE WINDOW IT LIVES IN, if that is not this one. `focus()`
      // ends in "make this panel active in its group", and a popped-out viewer
      // is alone in its group and therefore already active — so asking for a
      // file that is open in a viewer WINDOW used to be a literal no-op: no new
      // tab (correct), and nothing whatsoever on screen (not). That is the only
      // rule this registry still exists for, failing in the one case where the
      // document the user asked for is somewhere they may not be looking.
      const loc = panel.api.location;
      if (loc.type === 'popout') raisePopoutWindow(panel, loc.getWindow());
      return;
    }
    // The registry believes in a panel dockview does not have — only reachable
    // if a removal never reported. Correct the registry and open properly
    // rather than dropping the user's click on the floor (fail-open).
    forgetDocumentPanel(plan.id);
    openDocumentPanel(api, filePath, colorScheme, sessionId);
    return;
  }
  try {
    api.addPanel({
      id: plan.id,
      component: 'documentViewer',
      title: documentTabTitle(filePath),
      params: { path: filePath, colorScheme, sessionId: sessionId ?? null },
      position: { referenceGroup: documentHomeGroup(api) },
    });
  } catch (err) {
    // `addPanel` throwing means no panel was ever created, so `onDidRemovePanel`
    // will never fire for it — the registry would keep an entry for a panel that
    // does not exist, and the next request for that same file would `focus` a
    // ghost instead of opening it (it self-heals through the branch above, but a
    // click later). Reachable: `seq` restarts at 0 each renderer, and a
    // `fromJSON` that throws part-way through restore can leave a `doc-1` behind
    // for the prune to miss.
    forgetDocumentPanel(plan.id);
    console.error('[document] could not open a viewer', err);
  }
}

/**
 * Pop a viewer out to its own OS window, or dock it back (P2-E16-03, §5.30).
 *
 * "Pop it open in its own window is the same `addPopoutGroup` a session card
 * uses" — so this is `popOutCardPanel` with the session bookkeeping removed,
 * and the removal is the whole difference: a card's popout carries the two
 * dock-back semantics (a button toggle keeps the session alive, a window close
 * suspends it) because there is a CHILD PROCESS on the other end of it. A
 * viewer is a file on disk. Closing its window means "put it back", every time,
 * and dockview's own teardown does exactly that — the group returns to the
 * reference group it left. Nothing to disambiguate, so nothing is flagged.
 *
 * That reasoning is about the VIEWER, not about the window. A user can drag a
 * session card into a viewer's window, and docking back from here then closes
 * the window under that card too — with nothing arming the card's own
 * dock-back flag, so its session suspends. Deliberate: it is bit-for-bit what pressing the window's own ✕
 * does, and a viewer's control has no business deciding a session's fate.
 */
export function popOutDocumentPanel(api: DockviewApi | null, panelId: string): void {
  const panel = api?.getPanel(panelId);
  if (!api || !panel) return;
  const loc = panel.api.location;
  if (loc.type === 'popout') {
    loc.getWindow()?.close();
    return;
  }
  const popoutUrl = new URL('popout.html', window.location.href).toString();
  void api.addPopoutGroup(panel, { popoutUrl });
}

/**
 * The viewers "Close all documents" may take, in dockview's terms (#543).
 *
 * The RULE — which ones, and why a popped-out one is spared — is
 * `lib/document-panels`' `closableDocuments`, unit-pinned there. This is only
 * the dockview half: asking each panel where it currently lives. Written as one
 * function because both the command's ENABLED state and its RUN need the same
 * answer, and two reads of it are how a palette entry ends up offered and then
 * doing nothing.
 */
function closableDocumentIds(api: DockviewApi | null): string[] {
  if (!api) return [];
  return closableDocuments(
    api.panels.map((p) => ({ id: p.id, poppedOut: p.api.location.type === 'popout' }))
  );
}

function DocumentViewerPanel(
  props: IDockviewPanelProps<{
    path?: string;
    colorScheme?: string;
    sessionId?: string | null;
    // NO `pinned`, and its absence is a decision (#530). A saved layout written
    // before this change carries one, and `fromJSON` hands the whole params
    // blob back verbatim — so the key still ARRIVES here. It is simply never
    // read: dockview does not validate params, nothing draws a pin any more,
    // and the restore drops every `doc-` panel moments later anyway (see
    // `onReady`). A stale pin therefore cannot crash and cannot resurrect the
    // behaviour, which `document-peek.spec` proves by planting one.
  }>
): React.JSX.Element {
  const api = props.api;
  const containerApi = props.containerApi;
  // Stable identity: the viewer holds this in an effect's deps, so an inline
  // arrow would re-run `setTitle` on every render of the panel.
  const setTitle = React.useCallback((title: string) => api.setTitle(title), [api]);

  // Where the panel IS, kept live: the header's one control has to read "dock
  // back" the instant the window opens, and dockview is the authority on that
  // (the same `onDidLocationChange` a card uses for its own toggle).
  const [poppedOut, setPoppedOut] = React.useState(() => api.location.type === 'popout');
  React.useEffect(() => {
    setPoppedOut(api.location.type === 'popout');
    const d = api.onDidLocationChange(() => setPoppedOut(api.location.type === 'popout'));
    return () => d.dispose();
  }, [api]);

  // "dockview just moved your DOM" (#562) — the document panel's own copy of
  // the signal `SessionCardPanel` raises for a card's panels (#555).
  //
  // A DOCUMENT PANEL IS NOT A CARD PANEL, and that is the whole reason this is
  // here rather than threaded through a prop: `PanelContext.dockEpoch` is built
  // by `SessionCardPanel` and handed to the panel CONTRIBUTIONS. A viewer is a
  // top-level dockview panel with no card and no context, so it had no route to
  // this fact at all — measured, two documents in one group: read halfway down
  // one, glance at the other, come back, 722 -> 0.
  //
  // All three events, like the card's, rather than the one that happens to fire
  // today: they are rare, the handler is a counter, and re-applying a scroll
  // position the pane is already at is a no-op.
  const [dockEpoch, setDockEpoch] = React.useState(0);
  React.useEffect(() => {
    const bump = (): void => setDockEpoch((n) => n + 1);
    const ds = [api.onDidActiveChange(bump), api.onDidGroupChange(bump), api.onDidLocationChange(bump)];
    return () => ds.forEach((d) => d.dispose());
  }, [api]);

  // §5.24 attribution, resolved from the STORE and not from params — the same
  // argument `IdentityTab` records: a rename or a re-assigned accent has to
  // reach a viewer that has been on screen for an hour, and a copy frozen into
  // the layout blob at `addPanel` never could.
  const sessionId = props.params?.sessionId ?? null;
  const sessionName = React.useSyncExternalStore(subscribeStore, () =>
    sessionId ? sessionStore.getCardTitle(sessionId) : undefined
  );
  const sessionAccent = React.useSyncExternalStore(subscribeStore, () =>
    sessionId ? sessionStore.getCardAccent(sessionId) : undefined
  );
  // NO TITLE, NO CHIP. A viewer OUTLIVES the session it was opened from
  // (§5.30), and once that session is closed the store stops answering for the
  // card — at which point the lineage points at nothing and the honest thing is
  // to stop claiming it, rather than fall back to a raw card id no user has
  // ever seen. A live card always has a title, so this only fires on departure.
  const session = React.useMemo(
    () => (sessionId && sessionName ? { name: sessionName, accent: sessionAccent } : undefined),
    [sessionId, sessionName, sessionAccent]
  );

  const onPopoutToggle = React.useCallback(
    () => popOutDocumentPanel(containerApi, api.id),
    [api, containerApi]
  );

  // Is the find bar open on THIS viewer (#533)? Published by `find.open`, which
  // runs in App's keydown handler and cannot reach this tree — the same
  // publish/subscribe a session card uses, with the `doc-` panel id in the
  // cardId role.
  const findBar = React.useSyncExternalStore(subscribeFindBar, findBarState);

  return (
    // §5.30's litmus #3, in one wrapper: "read-only and out of band, wrapped in
    // `ContributionBoundary`; a viewer that throws cannot touch a session".
    // Without it a throw from the viewer's render or an effect propagates to the
    // renderer ROOT — there is no other boundary above a dockview panel — and
    // blanks every session pane in the window. The panel is not a contribution,
    // but the containment argument is the same one, and so is the component.
    // NOT KEYED ANY MORE (#530). P2-E16-03 keyed this on the path because
    // `ContributionBoundary` latched `failed` with no reset, and under a
    // REUSABLE peek slot one document that threw would poison the slot for
    // every glance after it. Nothing re-points a panel now — `path` is fixed
    // for the panel's life, the only later `updateParameters` on a `doc-` panel
    // being the theme heal, which merges — so the key could never change and
    // the remount it bought is unreachable.
    //
    // WHAT THAT COSTS, said plainly rather than left to be discovered: the
    // boundary renders NOTHING on failure (see `boundary.tsx`), so a viewer
    // that throws is a BLANK panel with a live tab title. It no longer stays
    // blank for the life of the panel, though — #463 gave the boundary a reset,
    // and this component re-renders often enough (the find bar opening, the
    // session store answering, a dock move, a pop-out) that a viewer which
    // threw once is retried by the next one of those. A viewer that throws
    // three times in a row is out of retries and blank for good; the recovery
    // then is the gesture it always was — close the tab and open the file
    // again, which is a fresh panel and a fresh boundary.
    // POSITIONED, because the bar is absolute and must move nothing underneath
    // it (§5.31 litmus 5) — the same box `SessionCardPanel` puts it in.
    <div style={{ position: 'relative', blockSize: '100%' }}>
      <ContributionBoundary id="document-viewer">
        <DocumentViewer
          path={props.params?.path ?? ''}
          panelId={api.id}
          colorScheme={props.params?.colorScheme === 'light' ? 'light' : 'dark'}
          onTitleChange={setTitle}
          poppedOut={poppedOut}
          onPopoutToggle={onPopoutToggle}
          session={session}
          // the reader's place, across a dockview move (#562)
          dockEpoch={dockEpoch}
        />
      </ContributionBoundary>
      {/* Document find (#533, §5.31). NO `sessionId`: a viewer is
          session-ATTRIBUTED and not session-owned, so there is no live session
          to search and `find-session` excludes itself from the groups. OUTSIDE
          the boundary, like the card's is: the bar is ours, not the viewer's,
          and a viewer that throws withdraws its surface — which the bar already
          knows how to say out loud (a greyed "nothing to search here") rather
          than vanishing along with it. */}
      {findBar.openOn === api.id && (
        <FindBar
          cardId={api.id}
          panelId="document"
          panelTitleKey="find.group.document"
          // clear of `.doc-header`, whose controls are the only ones this
          // surface has — see the prop's own note
          insetBlockStart={34}
        />
      )}
    </div>
  );
}

const components = {
  sessionCard: SessionCardPanel,
  diffPane: DiffPanel,
  documentViewer: DocumentViewerPanel,
};

/** Our dockview theme (#84) — one definition, applied at ready and on switch. */
function dockviewTheme(colorScheme: 'light' | 'dark'): DockviewTheme {
  return {
    name: 'switchboard',
    className: 'dockview-theme-switchboard',
    colorScheme,
    tabGroupIndicator: 'none',
  };
}

// live-id mapping, allow-all and per-card presentation all live in the store
// now (P2-E15-07, P2-E15-08) — see store/session-store.ts.

// ── WHEN A POPOUT WINDOW EMPTIES, WHERE DOES ITS LAST CARD GO? (#656, #657) ──
//
// dockview returns EVERY member of a closing popout window through ONE
// reference — `disposePopoutWindow` does `moveGroupWithoutDestroying({ from:
// group, to: referenceGroup })`, and `referenceGroup` is the group the window
// was torn from, recorded once when it opened. #558 gave the gesture we drive
// ourselves (⤡ with company) a proper answer via `dockBackTarget`. These three
// functions give the same answer to the returns DOCKVIEW drives, which #558
// could not touch and #657 is: the window closed from the OS, the ⤡ that
// empties it, a card left holding a window its opener made.
//
// THE CORRECTION IS A SECOND MOVE, AFTER THE PANEL IS SAFELY IN THE GRID, and
// that is not a detail — it is the whole reason this shape exists rather than
// the obvious one. Moving the LAST panel out of a popout group destroys the
// group, which closes its OS window, which makes Chromium strip every listener
// off the document it tears down — including React's, on the card DOM dockview
// adopted into that window. The card comes home rendering perfectly and
// answering nothing (#292 from the other side; it cost #564 an entire attempt).
// A grid→grid move is not that move and is perfectly safe.
//
// WHAT TELLS A RETURN FROM A DRAG is the ORDER of two dockview events, read off
// dockviewComponent.js rather than guessed:
//
//   * a window closing does `moveGroupWithoutDestroying` FIRST — which sets the
//     panel's group, firing `onDidLocationChange` — and only then
//     `doRemoveGroup(group)`, which removes the popout service entry and fires
//     `onDidRemovePopoutGroup`;
//   * a user dragging the last tab out does it the other way round:
//     `_doMoveGroupOrPanel` removes the panel, sees the group empty, calls
//     `doRemoveGroup` (→ `onDidRemovePopoutGroup`) while the panel is in LIMBO,
//     and re-opens it at the user's drop target afterwards.
//
// So: the location handler notes a card that has already come home, and
// `onDidRemovePopoutGroup` reads that note. A dragged card has not landed yet
// when the note is read, so it is never in it — which is exactly right, because
// a card the user dropped somewhere is not a card that needs placing.

/**
 * Cards whose `setMoving` the lone ⤡ armed, with the watchdog that releases it.
 *
 * The flag has to outlive the click: `w.close()` does not tear the window down
 * synchronously (the unload is a later task), so there is no `finally` to
 * release it in. The settle is the ordinary release; the watchdog is for the
 * window that never comes back at all — a card left permanently `isMoving`
 * would silently stop adopting a group on a real drag AND stop suspending when
 * its window is closed, which is a worse bug than the one this fixes.
 */
const armedDockBacks = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Cards dockview has just moved out of a popout and into the grid, waiting for
 * the `onDidRemovePopoutGroup` that confirms the window is gone — each with the
 * `home` it had AT THAT MOMENT.
 *
 * The snapshot is the whole reason this is a map and not a set, and it was
 * measured rather than reasoned: without it the fix silently did nothing.
 * dockview's return fires a layout change, `captureSlots` runs on it, sees the
 * card in a perfectly real grid group and banks that group as the card's home —
 * so by the time the settle asks "is this slot yours?", the answer has become
 * yes for the one card the question exists for. The record taken as the card
 * crossed back is the honest one.
 *
 * Entries live for ONE TASK — see `noteCardCameHome` for why an unread note is
 * a live hazard rather than a harmless leftover.
 */
const cameHomeFromPopout = new Map<string, SlotRef | null>();
/** Long enough that a slow window teardown is never mistaken for a lost one,
 *  short enough that a card is not stuck un-adoptable for a working day. */
const DOCK_BACK_WATCHDOG_MS = 10_000;

function armDockBack(cardId: string): void {
  disarmDockBack(cardId);
  sessionStore.setMoving(cardId, true);
  armedDockBacks.set(
    cardId,
    setTimeout(() => {
      armedDockBacks.delete(cardId);
      sessionStore.setMoving(cardId, false);
      console.warn('[popout] a card never came home from its dock-back; releasing it');
    }, DOCK_BACK_WATCHDOG_MS)
  );
}

function disarmDockBack(cardId: string): void {
  const timer = armedDockBacks.get(cardId);
  if (timer === undefined) return;
  clearTimeout(timer);
  armedDockBacks.delete(cardId);
  sessionStore.setMoving(cardId, false);
}

/**
 * Drop every dock-back arm and note — the grid they belong to is going away.
 *
 * A `setMoving` flag that outlives its dockview instance is a card that will
 * never adopt a group on a drag and never suspend when its window is closed,
 * and no gesture would ever clear it: the settle that normally does is driven
 * by an event that instance will not fire again.
 */
export function forgetDockBacks(): void {
  for (const cardId of [...armedDockBacks.keys()]) disarmDockBack(cardId);
  cameHomeFromPopout.clear();
}

/**
 * Is this popout→grid transition dockview handing the card back?
 *
 * The two moves we make ourselves are excluded, because both have already
 * decided where the card goes: the ⤡-with-company branch `moveTo`s it, and
 * hiding removes the panel outright (there is not even a panel left to place).
 * The lone ⤡ arms `isMoving` as well and IS one of dockview's returns —
 * `armedDockBacks` is how it says so.
 *
 * Exported with the rest of the mechanism: it is the RULE half of the
 * discriminator, and the one part of it a unit test can ask directly.
 */
export function isDockviewReturn(cardId: string): boolean {
  if (sessionStore.isHiding(cardId)) return false;
  return armedDockBacks.has(cardId) || !sessionStore.isMoving(cardId);
}

/**
 * The location handler's half of the note — see the block comment above.
 *
 * Exported with `settleDockedBackCards` because the PAIR is the mechanism and
 * neither half means anything alone: the note is what makes a dockview return
 * distinguishable from a user drag, and the settle is what reads it. The unit
 * tests drive both against `fakeGrid`; the real event ORDER that fills the note
 * is only observable in e2e, and `popout-dock-back.spec.ts` is where it is
 * pinned.
 */
export function noteCardCameHome(cardId: string): void {
  cameHomeFromPopout.set(cardId, sessionStore.getPresentation(cardId).home);
  // ...AND IT EXPIRES IN THIS TASK, which is the other half of the
  // discriminator and not a tidy-up. A note is only ever read by the
  // `onDidRemovePopoutGroup` dockview fires LATER IN THE SAME SYNCHRONOUS
  // OPERATION — `disposePopoutWindow` moves the panels home and then removes
  // the group — so a microtask is comfortably after every honest reader.
  //
  // THREE OTHER popout→grid moves leave a note nothing will ever drain, and
  // the list is exhaustive against `dockviewComponent.js` rather than plausible:
  //
  //  1. a tab dragged out of a window that SURVIVES — no group is removed, so
  //     `onDidRemovePopoutGroup` never fires at all;
  //  2. the drag that EMPTIES one — `_doMoveGroupOrPanel` removes the group
  //     while the panel is still in limbo, so the settle runs before the note
  //     exists;
  //  3. a window whose reference group is gone (`disposePopoutWindow`'s
  //     `else if (anchorPresent && ...)` branch, :1268): `doRemoveGroup` runs
  //     at :1292 and the location only becomes `grid` at :1297, so again the
  //     settle is first. This one is a REAL close that gets no placement, and
  //     it is deliberately left alone: that branch re-docks the whole popout
  //     group into the grid intact (`doAddGroup(group, [0])`), so nobody is
  //     routed through a reference and there is no unearned slot to correct.
  //     Covering it would need a second trigger; it wants its own ticket.
  //
  // Left in the map, any of the three would be drained by an unrelated window
  // closing minutes later and would teleport a card the user had deliberately
  // placed, on a `home` snapshot taken before they placed it.
  queueMicrotask(() => cameHomeFromPopout.delete(cardId));
}

/**
 * Place every card a just-closed popout window handed back (#656, #657).
 *
 * Deferred by a microtask for `rescueStrandedPopouts`' reason: dockview fires
 * `onDidRemovePopoutGroup` from INSIDE its own teardown, and moving a panel
 * there is moving furniture out from under it. A microtask lands after the
 * whole synchronous disposal, when the layout has settled.
 *
 * Exported for the unit tests, which drive it against `fakeGrid` — the real
 * ordering is e2e's, this is the placement.
 */
export function settleDockedBackCards(api: DockviewApi): void {
  const cards = [...cameHomeFromPopout];
  cameHomeFromPopout.clear();
  if (cards.length === 0) return;
  // A QUIT IS NOT A DOCK-BACK. The layout being written on the way out is the
  // one WITH the popout in it, and §5.25 promises that window comes back; the
  // same is true of a restore, which is that layout being rebuilt. Cards are
  // still disarmed, because the flag must never outlive the gesture.
  const settle = !sessionStore.isTearingDown() && !sessionStore.isRestoringLayout();
  queueMicrotask(() => {
    for (const [cardId, home] of cards) {
      try {
        if (settle) placeCardComingHome(api, cardId, home);
      } catch (err) {
        // fail-open, per card: one card we cannot place must not cost the
        // others their placement, and none of this may throw into dockview
        console.error('[popout] could not place a card coming home', err);
      } finally {
        disarmDockBack(cardId);
      }
    }
  });
}

/**
 * One card: keep where dockview put it, or move it to where it belongs.
 *
 * `home` is the record the card carried across, NOT the one in the store — see
 * `cameHomeFromPopout` for the layout-change race that makes the difference
 * between this fix working and this fix being a no-op.
 */
function placeCardComingHome(api: DockviewApi, cardId: string, home: SlotRef | null): void {
  const panel = api.getPanel(`session-${cardId}`);
  if (!panel) return; // hidden, closed, or it went down with its window
  const landing = panel.group;
  // It is in ANOTHER window — dragged on somewhere while we waited a
  // microtask, or restored into a popout. Not ours to move.
  if (landing.api.location.type !== 'grid') return;
  const homeGroup = slotGroup(api, home);
  if (
    keepsInheritedGroup({
      landingGroupId: landing.id,
      landingGroupSize: landing.panels.length,
      homeId: homeGroup?.id ?? null,
    })
  ) {
    return;
  }
  // It is alone in a slot that is not its own: the reference it inherited. The
  // landing group is EXCLUDED from the fallback — dockview un-hides the husk on
  // the way in, so "the first visible grid group" is now the wrong slot itself.
  const dest = dockBackTarget(api, home, landing);
  if (dest.group === landing) return;
  // OUR move, not a user drag (see setMoving) — and note the emptied landing
  // group goes with it: dockview destroys a group whose last panel leaves,
  // which is what clears the abandoned sliver off the screen.
  sessionStore.setMoving(cardId, true);
  try {
    panel.api.moveTo({ group: dest.group, ...(dest.index >= 0 ? { index: dest.index } : {}) });
  } catch (err) {
    console.error('[popout] could not place a card coming home', err);
    // ...and put the slot away again, exactly as the ⤡ branch does: an empty
    // shell left visible is a blank pane the user has to look at.
    if (dest.revived && dest.group.panels.length === 0) dest.group.api.setVisible(false);
  } finally {
    sessionStore.setMoving(cardId, false);
  }
}

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
    // ── ⤡ WITH COMPANY MEANS "BRING THIS CARD HOME", NOT "CLOSE THE WINDOW" ──
    //
    // Dock-back is normally a window close, and that was exact while a session
    // popout held exactly one card. It is not any more (#531): dockview hands
    // EVERY member of a closing popout back to the grid, and each one arrives
    // at the location handler above with no dock-back flag of its own — so
    // it is indistinguishable from the user closing the window, and gets
    // `dropLive`d and suspended. Docking one card back would tear down the live
    // session sitting next to it. #531 made that the ordinary shape rather than
    // something you could only reach by dragging a tab across windows.
    //
    // So when this card has company, move the PANEL and leave the window
    // standing. The question asked is "would closing this drag anyone else
    // home?", which is about the WINDOW and not this panel's group — a split
    // inside a popout, or a document viewer sharing it, counts the same way.
    //
    // `dockBackTarget` picks where it lands: the card's OWN slot when it still
    // has one, and otherwise #501's placement rules, in one place — a card that
    // never lived in the grid arrives where a new one would, never in the
    // document area and never inside somebody else's hidden husk.
    const company =
      !!w &&
      api.panels.some((p) => {
        if (p === panel) return false;
        const l = p.api.location;
        return l.type === 'popout' && l.getWindow() === w;
      });
    if (company) {
      const dest = dockBackTarget(api, sessionStore.getPresentation(cardId).home);
      // `setMoving`, which replaced E8-04's separate `markDockingBack` flag.
      // Both kept the session alive across the location change — the handler
      // bails before the suspend either way — and this one ALSO stops E12-04
      // reading a dock-back as a user drag. That bites HERE and not on the
      // window-close branch: this is a `moveTo`, i.e. `_doMoveGroupOrPanel`,
      // where the adoption handler really does run. The card lands in its OWN
      // slot, which is an EMPTY husk in the ordinary case, so adoption would
      // see no siblings and erase the session's persistent group outright
      // (`pickAdoptedGroupId` returns null). Docking a card back is a
      // placement, not a regrouping.
      sessionStore.setMoving(cardId, true);
      try {
        panel.api.moveTo({ group: dest.group, ...(dest.index >= 0 ? { index: dest.index } : {}) });
      } catch (err) {
        // The group died between the lookup and the move. `moveTo` is
        // synchronous, so this is an exception and would otherwise escape a
        // click handler; the card stays in its window instead, which is a
        // dock-back that visibly did nothing — hence the log, so it is not also
        // an INVISIBLE one.
        console.error('[popout] could not dock the card back', err);
        // ...and put the slot away again. We un-hid it to land in, and an empty
        // shell left visible is a blank pane the user has to look at.
        if (dest.revived && dest.group.panels.length === 0) dest.group.api.setVisible(false);
      } finally {
        sessionStore.setMoving(cardId, false);
      }
      return;
    }
    // ── THE LAST CARD OUT STILL LEAVES BY CLOSING THE WINDOW ────────────────
    //
    // and it must, which is worth writing down because the obvious symmetry —
    // `moveTo` here as well, then close the empty window — is a trap that has
    // already cost one attempt at this issue (#564). dockview's
    // `_doMoveGroupOrPanel` removes the panel from its group, then destroys the
    // now-empty group BEFORE re-opening the panel at its destination
    // (`doRemoveGroup(sourceGroup)` sits between the two, outside the moving
    // lock). Destroying a popout group closes its OS window, and Chromium
    // strips every listener off the document it tears down — including React's,
    // on the card DOM dockview had adopted into that window. The card arrives
    // home rendering perfectly and answering nothing: #292's story, reached
    // from the other side. The window-close path does the move from INSIDE the
    // window's own teardown, while the document is still alive, which is why it
    // is the one that keeps a session usable.
    //
    // dockview then hands the panel to the group the WINDOW was created from,
    // which for the card that tore that window off IS its own slot: the two
    // placements agree on the case this branch actually serves. Where they
    // disagree — the card born in the window (#531) left holding a reference it
    // never earned, or a home that has moved on — `settleDockedBackCards`
    // corrects it AFTER the panel is safely in the grid (#656/#657). That is
    // the "second move" the previous version of this comment said needed its
    // own ticket; the ticket is done, and the correction is a grid→grid move,
    // which is the safe kind. Only the LAST-PANEL-OUT move is fatal.
    //
    // `setMoving`, and not the one-shot dock-back flag this branch used to
    // arm — the same swap the company branch made, for the same two reasons.
    // Both keep the session alive across the location change (the handler bails
    // before the suspend either way); this one ALSO covers the settle's own
    // corrective move below, which goes through `_doMoveGroupOrPanel` where
    // E12-04's adoption really can fire and would rewrite the session's
    // persistent group from whatever the destination's tabs happen to belong to.
    //
    // #656 SAID THE UNFLAGGED RETURN ALREADY ERASED THAT GROUP. Measured on
    // unfixed main (2026-08-21): it does not, and the reason is one layer down.
    // dockview's `openPanel` calls `updateParentGroup` — which fires
    // `onDidGroupChange` — BEFORE `doAddPanel` registers the panel in its new
    // group, so `adoptMembershipFromDockGroup`'s own `containerApi.getPanel(id)`
    // answers `undefined` and it returns before it can decide anything. The
    // group survived by accident, in code that knows nothing about popouts.
    // Arming here makes the same outcome DELIBERATE, and it is what stops that
    // accident becoming a bug the day the adoption handler is repaired. The
    // guard is the e2e in `popout-dock-back.spec.ts`.
    //
    // The flag is released by the settle, or by its watchdog if the window
    // never comes back at all.
    //
    // only arm it when a window actually exists to close, else the flag would
    // be armed for a card that is going nowhere (E8-04's review made the same
    // point about the flag this replaces).
    if (w) armDockBack(cardId);
    w?.close();
    return;
  }
  // Drop a dock-back arm this card is still carrying — a window that never
  // came home (see `armedDockBacks`) must not leave the card un-adoptable now
  // that it is being popped out again.
  disarmDockBack(cardId);
  // same-origin popout.html; the terminal keeps running because its JS stays
  // in this window while its DOM is adopted into the new OS window (E8)
  const popoutUrl = new URL('popout.html', window.location.href).toString();
  void api.addPopoutGroup(panel, { popoutUrl });
}

/**
 * Bring home every card whose popout window died without telling anyone (#292).
 *
 * #279 taught the registry to notice a window that closed with no event — the
 * task bar's close, a crash, the OS taking it. That stopped the bookkeeping
 * lying; it did not give the user their session back. dockview still has the
 * card in a popout group whose window is a corpse, so the card is in no window
 * at all: not in the grid, not on screen, and reachable only by closing the
 * card outright. This is the half that puts it back.
 *
 * THE CARD IS REBUILT, NOT MOVED, and that is the fact the whole shape hangs
 * on. dockview ADOPTS a popped-out card's DOM into the other window's document,
 * and when the OS destroys that window Chromium strips every event listener off
 * every node in the document it is tearing down — React's included. Carrying
 * those nodes back into the main window gives you a card that renders perfectly
 * and answers no clicks: a picture of a session, with a Resume button that does
 * nothing. (That was this function's first draft; the e2e below is what caught
 * it, and no unit test could have.) So the dead panel is taken away and the card
 * is built again from its record — the ladder's hidden rung and a reveal, both
 * of which already exist and are how every panel-less card comes back.
 *
 * AND IT SUSPENDS, exactly as a clean close does. To the user a window taken by
 * the OS and a window closed with its own X are the same event; whether dockview
 * happened to hear about it is our implementation detail, and "closing a popout
 * suspends the session — unless we missed the close" is not a rule anybody could
 * hold in their head. The card's own `onDidLocationChange` handler would
 * normally do this (E8-04), and cannot here: it never sees a location change,
 * because its panel goes straight from the dead window to nowhere. So the two
 * store writes and `dropLive` are made here instead, deliberately mirroring it.
 *
 * Not during teardown or a layout restore: both are moments when dockview's own
 * popout state is mid-flight, and a rescue then would rewrite the layout being
 * saved — quitting with a dead popout would lose the window arrangement it
 * should come back with. Neither costs the user the card: a quit leaves the
 * popout in the saved layout, so the next launch just reopens the window, and a
 * restore is where those windows are being created in the first place.
 */
export function rescueStrandedPopouts(api: DockviewApi | null): void {
  if (!api || sessionStore.isTearingDown() || sessionStore.isRestoringLayout()) return;
  try {
    for (const stranded of strandedByGroup(api.panels).values()) {
      for (const panel of stranded) {
        try {
          const cardId = /^session-(.+)$/.exec(panel.id)?.[1];
          // A DERIVED tab went into the window with its card, and both kinds are
          // DROPPED rather than rebuilt beside a suspended session.
          //
          // A diff has no record and no state worth keeping — the card's
          // Changes tab rebuilds it whenever it is asked for again.
          //
          // A VIEWER (P2-E16-03) could be rebuilt — the registry still knows its
          // path — and is deliberately not. §5.30 lists display-rescue among the
          // machinery a viewer inherits, so this is a divergence and is called
          // one: a rescued viewer would arrive UNASKED, a tab appearing in the
          // main window because a monitor went away. (Until #530 it was worse
          // than unasked — it would also have spent the peek slot, replacing
          // whatever the user was reading. That half of the argument is gone
          // with the slot; the unasked half is the whole of it now, and it is
          // enough.) "Restoring open viewers" is E16's *Not in scope* line, and
          // this is the same question in miniature; the file is one click away
          // and the click is the user's. Revisit with that item.
          if (!cardId) {
            api.removePanel(panel);
            continue;
          }
          rescueStrandedCard(api, cardId);
        } catch (err) {
          // fail-open, and the loop continues: one card that cannot be rebuilt
          // must not cost the others their rescue.
          console.error('[popout] could not bring a stranded card home', err);
        }
      }
    }
  } catch (err) {
    // The registry calls its listeners inside its own try (popout-windows'
    // `fire`), but the microtask that makes this rescue safe to run also puts
    // it OUTSIDE that protection — and `api.panels` on a dockview that is
    // mid-teardown is exactly the read `saveLayout` already guards against. An
    // uncaught rejection from a janitor would be a worse bug than the one it
    // fixes.
    console.error('[popout] the stranded-card sweep failed', err);
  }
}

/** One card: take the dead panel away, suspend, build it again in the grid. */
function rescueStrandedCard(api: DockviewApi, cardId: string): void {
  // The ladder's own "take the panel away, and this is NOT the user closing the
  // card": it flags the removal so `onDidRemovePanel` keeps the record, banks
  // the slot, and clears `poppedOut`. Removing the last panel of the popout
  // group is also what makes dockview forget the window and the empty shell it
  // left in the grid, so the ghost goes with it.
  removePanelKeepingSlot(api, cardId, 'hidden');
  // Then exactly what the card's own location handler does when a popout window
  // closes (E8-04) — because that is what happened. The card cannot do it for
  // itself here: it is being unmounted, and it never saw a location change,
  // since the panel went straight from the dead window to nowhere.
  sessionStore.forgetCardLiveIds(cardId);
  sessionStore.setPresentation(cardId, { suspended: true });
  console.log(`[popout] window gone — rebuilding session-${cardId} in the grid`);
  // And build it again. NOT a move: when the OS destroys a window, Chromium
  // strips every event listener from the document it is destroying — including
  // the ones React put on the card's DOM, which dockview had adopted into that
  // window. Carrying those nodes back into the main window gives you a card
  // that RENDERS and answers no clicks: the Resume button below would be a
  // picture of a button. Only a fresh mount is a working card, which is why
  // this is the hidden rung and a reveal rather than `moveTo`.
  //
  // WITH focus, which the attention reveal deliberately does not take. Two
  // reasons, and neither is "it looked nicer": a clean close activates the
  // group it hands back, so this is parity again; and a reveal without focus
  // adds the panel INACTIVE, which for the card's own fresh group means a
  // rescued card that is present, correct, and drawn by nobody. The window that
  // just died is overwhelmingly the one the user was looking at.
  void revealCardPanel(api, cardId, true).catch((err) => {
    console.error('[popout] the rescued card could not be rebuilt', err);
  });
  // Last, because it is the only step that leaves this window: main lets the
  // session go, the same suspend a bare window close performs. Everything the
  // user can see is already right if this never comes back.
  void window.switchboard.sessions.dropLive(cardId);
}

/**
 * Bring the OS window a popped-out panel lives in to the FRONT (#571).
 *
 * THE RENDERER CANNOT DO THIS ON ITS OWN, which is why clicking a popped-out
 * session in the rail appeared to do nothing: `window.focus()` on another
 * window does not raise it on Windows. The intent has been in `focusSession`
 * since E9-01 and the mechanism was never able to carry it — so main does the
 * raising, keyed by the dockview group id it already tracks per popout window
 * (#531's registry).
 *
 * Both are attempted, in this order and deliberately: `window.focus()` is
 * synchronous, costs nothing and is enough on some platforms; the IPC is the one
 * that actually works on the owner's. Neither is load-bearing on the other.
 *
 * ONE DIRECTION ONLY. This raises a popout when the user asked for THAT session
 * — a rail click, the attention jump, a document opened by name. Focusing the
 * main window still leaves popouts exactly where they are, which the owner asked
 * for explicitly and which nothing here touches.
 */
function raisePopoutWindow(panel: IDockviewPanel, domWindow: Window | undefined): void {
  domWindow?.focus();
  const groupId = panel.group?.id;
  if (!groupId) return;
  void window.switchboard.raisePopout?.(groupId)?.catch?.(() => {
    // a window that closed between the click and the answer: the click has
    // already done everything it can, and a rejection here would be an
    // unhandled one in a click handler
  });
}

/** The popout window's rect on screen, when this panel is in one. */
function popoutBoxOf(panel: IDockviewPanel): Box | null {
  const loc = panel.api.location;
  if (loc.type !== 'popout') return null;
  const w = loc.getWindow();
  // A CLOSED window is as good as no window (#292). Its proxy still answers,
  // with zeroes, and this rect becomes the card's remembered monitor — so a
  // layout change in the seconds between a popout dying and the sweep noticing
  // would quietly overwrite "where you left it" with a 0×0 box at the origin.
  if (!w || w.closed) return null;
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
export function captureSlots(api: DockviewApi): void {
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
    // A GRID slot is also this card's HOME — the thing ⤡ brings it back to
    // (#558). Written here rather than in `popOutCardPanel` because the button
    // is not the only way into a window: a tab dragged across, a reveal that
    // re-opens a popout and a layout restore all get there too, and a home
    // recorded on only one of those routes is a home that is missing exactly
    // when it is needed. A popout slot never overwrites it — a card in another
    // OS window has not moved house, it has gone out.
    //
    // `isConnected` is the guard, and it earns its place: a saved popout is
    // rebuilt by `fromJSON` as an ordinary group that reports `location: 'grid'`
    // and does not become a popout until dockview's restoration timer fires
    // ~100ms later (#494 measured that window from the other side). It is a
    // grid slot in every way this loop can see, and it is not one — it is in no
    // document at all, because the OS window it belongs to has not been opened
    // yet. Recording it would REPLACE the real home the blob just restored, and
    // nothing would ever put that back: `slot` is corrected by the very next
    // layout change, once the group is honestly a popout, but a home is only
    // ever written from the grid, so the correction never comes.
    const settled = slot?.location === 'grid' && panel.group.element.isConnected;
    if (slot) sessionStore.setPresentation(m[1], { slot, ...(settled ? { home: slot } : {}) });
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
    // §5.8's pinning contract (E9-09): this is the "auto-collapse sweep" it
    // names, and a pinned card sits it out
    pinned: sessionStore.isPinned(cardId),
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
    if (existing) moveHome(api, cardId, existing, focus);
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

/**
 * Put a card that HAS a panel back at its home slot, and mark it expanded.
 *
 * Synchronous, and says so (#255 T2). There was never an `await` in the body —
 * that is what `require-await` fired on — and nothing it calls hands back a
 * promise to lose, which `no-floating-promises` has checked for this file
 * since #255's T0 put the renderer on the typed preset. So
 * the `async` bought exactly one thing: a microtask between the last move and
 * the caller's `finally`. Dropping it means `revealCardPanel` clears its
 * `laddering` guard in the same tick as the move it was guarding, rather than
 * one turn of the microtask queue later.
 */
function moveHome(
  api: DockviewApi,
  cardId: string,
  panel: IDockviewPanel,
  focus: boolean
): void {
  const slot = sessionStore.getPresentation(cardId).slot;
  // `slotGroup` and not the location-blind `find` this replaces (#502). It is
  // the same husk blindness #501 closed on the `+ session` and reveal doors,
  // one path over — and this was the third sighting of the pattern:
  //
  //  * a remembered group that has become a HUSK is still this card's slot, and
  //    is reported here so the move can un-hide it. Landing in a hidden leaf
  //    puts the card in the DOM, in the right window, and ~1px wide — which
  //    `toBeVisible()` cannot see, hence the e2e measuring geometry;
  //  * one that has become the DOCUMENT AREA is refused: a session never
  //    displaces what you are reading (#462/#501), even when the group used to
  //    be its own;
  //  * one that is now a POPOUT is refused too, which the old code did not do
  //    at all — a rung change would have moved the card into another OS window,
  //    the exact surprise the fresh-group branch below already argues against.
  const home = slotGroup(api, slot);
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
      // The husk is un-hidden BEFORE the move, the same revival `gridRefGroup`
      // and `dockBackTarget` do with the same shell and for the same reason:
      // the group holds the geometry this card used to occupy, and it is a slot
      // again the moment it is on screen.
      const revived = !target.api.isVisible;
      if (revived) target.api.setVisible(true);
      try {
        panel.api.moveTo({
          group: target,
          ...(slot && slot.index >= 0 ? { index: slot.index } : {}),
          skipSetActive: !focus,
        });
      } catch {
        // FAIL-OPEN, and unlike `revealNow`'s identically-shaped catch this one
        // really does lose the move: there the panel had already been ADDED to
        // the target and only the reposition failed, so the card was in the
        // right group either way. Here the `moveTo` IS the arrival — the card
        // stays in the stack, still marked expanded, which is a rung that
        // visibly did nothing rather than a card that has gone missing.
        //
        // So put the shell away again if we un-hid it and nothing arrived: the
        // two other revival sites do exactly this, and an empty visible pane is
        // a blank rectangle the user has to look at.
        if (revived && target.panels.length === 0) target.api.setVisible(false);
      }
    } else if (!target) {
      // Home is gone, unusable (see `slotGroup` above), was never recorded, or
      // IS the stack. Give it a group of its own in the grid rather than
      // leaving it where it is.
      //
      // `api.addGroup()` and deliberately NOT `sessionCardHome`, which is the
      // fallback its two sibling paths use: a card stepping OUT of the tab
      // stack is standing in a group that satisfies every one of that
      // function's rules — visible, in the grid, not the document area — so it
      // would frequently be handed the stack straight back, and "expanded"
      // would be a rung that moved nothing. A fresh group is visible and is
      // neither a husk nor the document area, so #501's contract holds either
      // way; the difference is only that this branch needs somewhere NEW.
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
  const cards = answered(await window.switchboard.sessions.cards()) ?? []; // #650
  const card = cards.find((c) => c.cardId === cardId);
  if (!card) return; // the record is gone — there is nothing to reveal
  const place = placeAt(
    sessionStore.getPresentation(cardId).slot,
    api.groups.map((g) => g.id)
  );
  const target = place.groupId ? api.groups.find((g) => g.id === place.groupId) : undefined;
  // its old group may have died with it (removing a group's last panel destroys
  // the group) — land it in the grid rather than nowhere. The fallback is the
  // same one `addSessionCard` uses (#462): a card coming back from `hidden` has
  // exactly the same claim to a VISIBLE group that is not the document area,
  // and the old location-only `find` had the same husk blindness.
  const refGroup = target ?? sessionCardHome(api);
  // ...and the REMEMBERED group can be that same hidden shell: hide card A, pop
  // its group-mate B out, and the group A calls home survives as B's dock-back
  // husk. Revive it rather than landing A at home and 0px wide — exactly what
  // `gridRefGroup` does with the same shell, for the same reason.
  //
  // NOT when the slot is a popout: the card is added here only to be torn out
  // again below, and dockview's PANEL popout does not re-hide the group it left
  // (`_doAddPopoutGroup` hides only in the whole-group branch), so revived-then-
  // abandoned would leave an empty pane on screen where a hidden shell was.
  if (!place.popout && refGroup.api.location.type === 'grid' && !refGroup.api.isVisible) {
    refGroup.api.setVisible(true);
  }
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
    // #650: `.some` on the brand throws. No display list means we cannot
    // prove the remembered rect is on a monitor, so take the rescue below -
    // opening on top of the main window is visible, and off-screen is not.
    const areas = answered(await window.switchboard.workAreas()) ?? [];
    const onScreen = boxOnAnyDisplay(place.popout, areas);
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
  const cards = answered(await window.switchboard.sessions.cards()) ?? []; // #650
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
  /**
   * The whole ⊕ gesture — pick a folder, then add the card (E3-02/E3-04).
   *
   * Lands in the popped-out window the user is IN, when there is one, and in
   * the grid otherwise (#531). The palette's `New session…` runs this, so the
   * command is window-aware without a second entry in the list whose title
   * would also read "new session".
   */
  newSession: () => Promise<void>;
  /**
   * Would `newSession()` land its card in a popped-out window right now?
   *
   * Synchronous on purpose, and asked BEFORE the gesture starts: App's popout
   * key bridge pulls the main window forward after any command that ran, and
   * it reads that decision the instant `run` returns — long before a folder
   * dialog could resolve. Answering late would be answering never (#531).
   */
  newSessionTargetsPopout: () => boolean;
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
  /**
   * Open a §5.30 document viewer on an absolute path (P2-E16-02/03, #530).
   *
   * A NEW TAB every time, docked beside the documents already open; a file that
   * is already open is focused rather than opened twice. Nothing is replaced.
   * `sessionId` attributes the viewer to the card the request came from (§5.24)
   * — a tint and a chip, never ownership. It never lands in a session's group,
   * nor in a popped-out viewer's window — see the implementation's note.
   */
  openDocument: (absolutePath: string, sessionId?: string) => void;
  /** card id of the active session panel, or null (E9-01 command context) */
  activeCardId: () => string | null;
  /**
   * The project folder of the session the user is looking at, or null (#569).
   *
   * Read off the PANEL, not the rail store: the store's session list is filled
   * by a poll, so it is empty for the first seconds of a window's life — which
   * is exactly when someone opens the app and reaches for File > Open File. The
   * panel's own params are populated the moment it mounts and cannot lag.
   *
   * Falls back to the first visible session panel, matching the placement rule
   * (`activeSessionGroup`): with nothing focused, "where the work is".
   */
  activeSessionFolder: () => string | null;
  /**
   * Panel id of the active DOCUMENT viewer, or null (#533 command context).
   *
   * The §5.8 question `find-providers.ts` used to record as a blocker: what is
   * "the focused surface" when it is not a session card? A `doc-` panel, and
   * this is how a command names one.
   *
   * `sourceWindow` is the OS window the keystroke was typed in, when it was not
   * this one — see the implementation for why that is passed rather than
   * inferred.
   */
  activeDocumentId: (sourceWindow?: Window) => string | null;
  /** is this panel in its own OS window right now? (#533 — see App's openFind) */
  isPanelPoppedOut: (panelId: string) => boolean;
  /** close a card the way the tab ✕ does — including its confirm (E9-01) */
  closeCard: (cardId: string) => void;
  /** close EVERY session at once, sparing the pinned ones (§5.8's pinning
   *  contract, E9-09). One confirm for the lot, not one per card. */
  closeAllCards: () => void;
  /** close every DOCKED §5.30 viewer at once — the answer to tab accretion that
   *  #530 left open (#543). Popped-out documents are spared; see
   *  `lib/document-panels`' `closableDocuments` for why. */
  closeAllDocuments: () => void;
  /** how many documents `closeAllDocuments` would actually take, so the
   *  palette's enabled state and the command's effect are one read (#543) */
  closableDocumentCount: () => number;
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
   * Is this card's panel ON SCREEN right now (E9-10)?
   *
   * dockview's answer, not a rung: an `expanded` card can still be the
   * unselected tab of a stack. §5.8's focus-stealing policy turns on the word
   * "visible", and the only honest reading of it is "the user can see it",
   * which is a question only the dock can answer — except for a popped-out
   * card, where dockview cannot know and the window is asked instead.
   */
  isCardOnScreen: (cardId: string) => boolean;
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

  // Add a NEW card in the main window's grid — the drag-drop / rail path,
  // where the folder is already known. `newSession` is the ⊕ gesture.
  const addSessionCard = useCallback(
    (folder: string, groupId?: string) => addSessionCardTo(apiRef.current, folder, { groupId }),
    []
  );

  // Declared HERE and not beside the `+ session` button that calls it: the
  // controller effect below lists it in a dep array, which is evaluated during
  // render, and a `const` further down the component would still be in its
  // temporal dead zone when that array is built.
  const [error, setError] = React.useState<string | null>(null);
  // ⊕ flow: pick a folder, spawn, bind the card (E3-02/E3-04) — in whichever
  // window the ask came from (#531). The `+ session` button is in the MAIN
  // window's chrome, so from it `focusedPopoutGroup` is null by construction
  // and nothing about that path changes; what can answer otherwise is Mod+N
  // pressed inside a popped-out session, which App's key bridge dispatches
  // here, and the ＋ on a popped-out card's header — which does not ask this
  // question at all, because it already knows its own group.
  const newSession = useCallback(async () => {
    const api = apiRef.current;
    await newSessionIn(api, api ? focusedPopoutGroup(api) : null, setError);
  }, []);
  // The main window's own chrome does not INFER a destination — it knows one.
  // `newSession` above has to ask which window has focus because a keystroke
  // carries no such information; a click on a button that only exists in this
  // window carries it, and asking anyway would put #434/#462's regression back
  // within reach of a window manager that reports focus a moment late. Same
  // argument the card ＋ makes by naming its own group (lib/new-session-target).
  const newSessionInGrid = useCallback(() => newSessionIn(apiRef.current, null, setError), []);

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

  /**
   * End one session and forget every record keyed by its card — WITHOUT asking.
   *
   * The confirm belongs to the GESTURE, not to this: `closeCard` asks about one
   * card, `closeAllCards` asks once about the lot, and both then do exactly the
   * same thing per card. Extracted at E9-09 because the second caller made the
   * duplication a correctness problem rather than a tidiness one — the by-hand
   * branch is a hand-written copy of what `onDidRemovePanel` does, and two
   * copies of that list is how a new per-card record (a pin, say) ends up
   * retired on one close path and leaked on the other.
   *
   * A card WITH a panel is closed by removing it, because dockview's
   * `onDidRemovePanel` runs the same forgets; a HIDDEN card has no panel to
   * remove (§5.8's invariant: hiding chrome never removes capability, so
   * closing has to work on a card that isn't in the workspace) and is done by
   * hand here.
   */
  const retireCard = useCallback((cardId: string) => {
    const api = apiRef.current;
    const panel = api?.getPanel(`session-${cardId}`);
    if (api && panel) {
      api.removePanel(panel); // onDidRemovePanel -> the forgets below
      return;
    }
    sessionStore.forgetCardLiveIds(cardId);
    sessionStore.forgetPresentation(cardId);
    sessionStore.forgetLayoutCard(cardId);
    sessionStore.forgetPin(cardId);
    void window.switchboard.sessions.closeCard(cardId);
  }, []);

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

  // The remount half of `forgetDockBacks` (the quit half is a `beforeunload`
  // listener in `onReady`). A dev HMR pass — or anything later that remounts
  // the grid — leaves module-level arms behind, and an arm outlives its own
  // release: the settle that would clear it is driven by an event the disposed
  // dockview will never fire again.
  React.useEffect(() => {
    return () => forgetDockBacks();
  }, []);

  React.useEffect(() => {
    if (!props.controller) return;
    props.controller.current = {
      addSessionCard,
      newSession,
      // Reads `apiRef` at call time rather than closing over an api, so it
      // cannot answer from a stale grid; `focusedPopoutGroup` is the same
      // question `newSession` itself asks a tick later.
      newSessionTargetsPopout: () => {
        const api = apiRef.current;
        return !!api && focusedPopoutGroup(api) !== null;
      },
      moveCardToGroup: (cardId, groupId) => void clusterCardWithGroup(apiRef.current, cardId, groupId),
      hideCard,
      revealCard: (cardId, focus) => void revealCard(cardId, focus ?? true),
      isCardOnScreen: (cardId) => {
        const panel = apiRef.current?.getPanel(`session-${cardId}`);
        // No panel at all (collapsed, tabbed-away, hidden) is trivially not on
        // screen. `api.isVisible` is false for the unselected tabs of a group,
        // which is exactly the distinction the policy needs and the one a rung
        // cannot make.
        if (!panel) return false;
        const loc = panel.group.api.location;
        // A POPPED-OUT panel is where dockview's answer stops being the user's.
        // `isVisible` stays true for the active tab of a popout group whatever
        // that OS window is doing — behind this one, minimised, on another
        // virtual desktop — because dockview has no way to know. Taking it at
        // face value would let `smart`, the DEFAULT, raise a whole other window
        // over whatever the user is looking at, which is the loudest thing the
        // app can do and precisely what this setting exists to gate. So the
        // popout answers for itself: on screen means it already has focus, in
        // which case focusing it is a no-op and nothing is stolen.
        if (loc.type === 'popout') {
          try {
            return loc.getWindow()?.document.hasFocus() ?? false;
          } catch {
            // a window torn down between the lookup and the read: not on screen
            return false;
          }
        }
        return panel.api.isVisible;
      },
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
        raisePopoutWindow(panel, loc.getWindow());
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
      activeSessionFolder: () => {
        const api = apiRef.current;
        if (!api) return null;
        const folderOf = (p: { id: string; params?: Record<string, unknown> } | undefined): string | null => {
          if (!p || !/^session-/.test(p.id)) return null;
          const f = p.params?.folder;
          return typeof f === 'string' && f ? f : null;
        };
        const active = api.activePanel;
        // A POPPED-OUT session answers nothing here and falls through to the
        // first grid session below — deliberately, and unlike `activeCardId`
        // just above, which returns null in the same situation. That one names
        // the card a COMMAND will act on, where being wrong destroys something;
        // this is a hint about where a file browser should open, where being
        // vague is free and "nowhere" is worse than "the folder of the work in
        // the main window".
        const fromActive =
          active && active.group.api.location.type === 'grid' ? folderOf(active) : null;
        if (fromActive) return fromActive;
        for (const p of api.panels) {
          if (p.group.api.location.type !== 'grid' || !p.group.api.isVisible) continue;
          const f = folderOf(p);
          if (f) return f;
        }
        return null;
      },
      // A DOCUMENT, unlike a card, is reachable in EITHER window (#533).
      //
      // `activeCardId` refuses a popped-out panel because a card command acts
      // on things that live in THIS window — you would confirm-close a card you
      // cannot see. Every reason for that rule is absent here: find acts on the
      // viewer's own DOM, and the bar renders inside the same panel, which
      // dockview has re-parented into the popout window along with it. Refusing
      // would mean Ctrl+F in a viewer's own window did nothing, which is the
      // exact bug this issue closed.
      //
      // WHICH WINDOW THE KEYSTROKE CAME FROM IS AN ARGUMENT, not a guess, and
      // that is the whole subtlety here. `activePanel` does NOT follow the user
      // into another OS window: pop a viewer out and dockview leaves the grid's
      // own panel active, so a Ctrl+F typed in the viewer's window would
      // resolve to whatever is sitting behind it. Proven, not assumed — the
      // popped-out case of `document-find.spec` failed exactly that way first.
      //
      // `document.hasFocus()` was the obvious fix and is the wrong one: it is
      // what `isCardOnScreen` asks a popout, but here it decides which of two
      // windows a keystroke belongs to, and getting that backwards would send a
      // Ctrl+F typed over a session card to a document in another window. The
      // popout key bridge already knows the answer — it attached the listener
      // to that window — so it passes it, and there is nothing to infer.
      //
      // A source window we cannot place among the popout groups answers null,
      // NOT "the grid's active panel": a keystroke from a window holding a
      // session card must keep behaving exactly as it did before (#533 changed
      // documents, not cards).
      activeDocumentId: (sourceWindow) => {
        const api = apiRef.current;
        if (!api) return null;
        if (sourceWindow) {
          for (const group of api.groups) {
            const loc = group.api.location;
            if (loc.type !== 'popout') continue;
            let win: Window | null = null;
            try {
              win = loc.getWindow() ?? null;
            } catch {
              win = null; // torn down between the lookup and the read
            }
            if (win !== sourceWindow) continue;
            const shown = group.activePanel;
            return shown && isDocumentPanelId(shown.id) ? shown.id : null;
          }
          return null;
        }
        const panel = api.activePanel;
        return panel && isDocumentPanelId(panel.id) ? panel.id : null;
      },
      isPanelPoppedOut: (panelId) =>
        apiRef.current?.getPanel(panelId)?.api.location.type === 'popout',
      closeCard: (cardId) => {
        const panel = apiRef.current?.getPanel(`session-${cardId}`);
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
        // the confirm belongs to the gesture; retireCard (E9-09) does what
        // main's inline removePanel/by-hand branch did, for both call sites
        retireCard(cardId);
      },
      closeAllCards: () => {
        // RAIL ORDER, and the DECISION through lib/pinning's `bulkClose` rather
        // than a `filter` here: that function is §5.8's pinning exemption
        // itself, and routing every bulk operation through it is what stops the
        // next one — the eviction policy §5.8 anticipates — from having to
        // remember the rule. What is left in this function is only the dialogs
        // and the loop, which is all a component should own (E9-09).
        const { doomed, spared } = bulkClose(
          sessionStore.getRailOrder().flat.map((s) => s.id),
          sessionStore.getPins()
        );
        if (doomed.length === 0) {
          // every session is pinned: say so rather than opening a confirm for
          // an empty list, which reads as the command being broken
          window.alert(t('grid.closeAllNothing', { count: spared }));
          return;
        }
        if (!window.confirm(t('grid.closeAllConfirm', { count: doomed.length, spared }))) return;
        for (const cardId of doomed) retireCard(cardId);
      },
      closableDocumentCount: () => closableDocumentIds(apiRef.current).length,
      closeAllDocuments: () => {
        const api = apiRef.current;
        if (!api) return;
        // NO CONFIRM, and unlike `closeAllCards` above that is deliberate
        // (#543). A card's confirm is not about the count — it is there because
        // closing one ENDS A CHILD PROCESS and forgets its record, which no
        // amount of clicking undoes. A viewer is a read-only lens on a file:
        // closing thirty of them costs re-opening the ones you still wanted,
        // and #530's own argument for accretion is that a visible mess you can
        // undo beats a document that vanishes. A modal on the command whose
        // entire purpose is to remove friction would be ceremony.
        //
        // IDS SNAPSHOTTED FIRST: `api.panels` is live and `removePanel` mutates
        // it, so iterating it directly skips every other panel. The registry
        // half is `onDidRemovePanel`'s `forgetDocumentPanel`, which fires for
        // each of these — nothing to forget by hand, and deliberately not a
        // second copy of that list (the lesson `retireCard` records).
        for (const id of closableDocumentIds(api)) {
          const panel = api.getPanel(id);
          if (panel) api.removePanel(panel);
        }
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
        // A Changes tab is opened from the rail, which lives in the MAIN window
        // — so it must open there, not inside whatever popout dockview last
        // made active (E8-04, #434). Only when the active group is NOT in the
        // grid, though: while it is, `addPanel`'s own default is the group the
        // user is looking at, which is where a diff belongs in a split layout,
        // and dockview reads a `position` of `undefined` as no position at all
        // (`_doAddPanel`: `if (options.position) … else activeGroup`). So the
        // main-window case comes out byte-identical to before.
        //
        // `isVisible` as well as `location`, for the reason `gridRefGroup`
        // spells out: the group a popped-out card came from stays in the grid,
        // hidden, and defaulting into THAT one is how the tab ends up on the
        // right window and one pixel wide.
        const active = api.activeGroup;
        const inGrid = active?.api.location.type === 'grid' && active.api.isVisible;
        api.addPanel({
          id: `diff-${cardId}`,
          component: 'diffPane',
          title: t('diff.tabTitle', { title }),
          params: { folder, colorScheme: props.colorScheme },
          position: inGrid ? undefined : { referenceGroup: gridRefGroup(api) },
        });
      },
      openDocument: (filePath, sessionId) =>
        openDocumentPanel(apiRef.current, filePath, props.colorScheme, sessionId),
    };
    // eslint's exhaustive-deps plugin isn't installed; deps kept accurate by hand
  }, [props.controller, addSessionCard, newSession, hideCard, revealCard, setLadder, stepLadder, props.colorScheme, t]);

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
      // A document viewer took its scheme the same way and needs the same heal
      // — Monaco's theme in its source body is scheme-dependent.
      if (panel.id.startsWith('diff-') || panel.id.startsWith('doc-')) {
        panel.api.updateParameters({ colorScheme: props.colorScheme });
      }
    }
  }, [props.colorScheme]);

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
        // ...and the cards that window handed back get placed where they
        // BELONG rather than wherever its one dock-back reference pointed
        // (#656/#657). This event is the discriminator as well as the trigger:
        // the block comment on `settleDockedBackCards` has the two dockview
        // orderings it reads.
        settleDockedBackCards(api);
      });
      // ...and when one of those windows turns out to have died on its own
      // (#292), the card it was hosting comes home. The registry's own liveness
      // sweep (#279) is the trigger: it is already the one thing in the app that
      // asks whether a popout window is still there, so there is no second timer
      // and no second definition of "gone".
      //
      // ANY membership change, not just a removal. A removal is the one that
      // matters — that is the sweep reporting a corpse — but `changed` also
      // covers a card popped out while another one is stranded, which is the
      // same "honest moment" #279 sweeps on and costs a walk of a list that is
      // never more than a handful long. An ordinary close reaches here too and
      // finds nothing to do: dockview has already put that card back by then,
      // which is what makes this safe to hang off every change rather than
      // needing to know which kind it was.
      //
      // Deferred by a microtask because dockview fires these from INSIDE its own
      // removal, with the panel momentarily still in the group being torn down.
      // Rescuing there would be moving furniture out from under it; a microtask
      // lands after the whole synchronous teardown, when the answer is settled.
      const offRescue = subscribePopoutWindows({
        changed: () => queueMicrotask(() => rescueStrandedPopouts(api)),
      });
      window.addEventListener('beforeunload', () => offRescue());
      // window teardown must not be mistaken for the user closing cards
      window.addEventListener('beforeunload', () => {
        sessionStore.setTearingDown(true);
      });
      // ...and the dock-back bookkeeping goes with the grid that owns it: an
      // armed card carries a `setMoving` flag AND a live 10s timer, neither of
      // which should outlive the dockview instance that armed it. This listener
      // is the QUIT half only — `beforeunload` never fires for a remount, which
      // is why the component also drops them from an effect teardown.
      window.addEventListener('beforeunload', () => forgetDockBacks());
      // closing a card (tab X or the overlay) forgets it — it will NOT come
      // back next launch. Quitting keeps the record so sessions DO come back,
      // so we skip this during teardown (belt-and-suspenders vs Dockview
      // disposal ever firing removes).
      api.onDidRemovePanel((panel) => {
        if (sessionStore.isTearingDown()) return;
        // A closed viewer leaves the registry (P2-E16-03) — otherwise it keeps
        // an entry for a panel dockview no longer has, and asking for that file
        // again would `focus` a ghost instead of opening it.
        if (panel.id.startsWith('doc-')) {
          forgetDocumentPanel(panel.id);
          return;
        }
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
        // ...and its pin (E9-09), which would otherwise keep protecting — and
        // sorting first — a card that no longer exists
        sessionStore.forgetPin(m[1]);
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
        // `answered` (#440): a refused `workspace:getLayout` is a truthy
        // object, and handing it to `fromJSON` would report itself as a corrupt
        // layout — the one failure mode this whole block is written to avoid.
        const layoutAnswer = await window.switchboard.workspace.getLayout();
        const saved = answered(layoutAnswer);
        // A REFUSAL IS COUNTED WITH "no layout", and that is the opposite of
        // what the `#650` comments below do three times — so it needs saying.
        // Those prunes delete USER DATA keyed by card (drafts, pins, the manual
        // order), and "we could not ask" must never be allowed to look like
        // "you have none". A slot is not that: it is a POINTER INTO A LAYOUT,
        // by a group id this dockview mints from `1` on every fresh grid. If
        // `fromJSON` did not run — refused, absent, or thrown — the ids are
        // re-minted and a persisted `groupId: '2'` names a stranger's group.
        // `homeGroupId`/`placeAt` can refuse an id that is GONE; neither can
        // see one that is a coincidence. So all three of those outcomes forget,
        // and the thing forgotten is a pointer to a workspace that is not on
        // screen (#657).
        const layoutRefused = isIpcRefusal(layoutAnswer);
        if (layoutRefused) console.warn('[layout] the saved layout was refused; forgetting slots');
        if (saved) {
          // Resolved BEFORE the restore's try/catch, not inside it: an await in
          // there whose rejection is unrelated to the layout would abort the
          // stale-panel cleanup and the focus restore, and report itself as
          // "[layout] restore failed". `null` means "we do not know", which the
          // prune below treats as "prune no groups".
          const groupIds = await window.switchboard.groups
            .list()
            // #650: `?? null` and NOT `?? []`. The comment above is the reason
            // — `null` here means "we do not know", which prunes no groups,
            // while an empty array would assert that no group exists and prune
            // every one of them. A refusal is the first, never the second.
            .then((gs) => answered(gs)?.map((g) => g.id) ?? null)
            .catch(() => null);
          try {
            // WHICH PANELS ARE NOT COMING BACK, decided once and used twice
            // (#494): the popout groups are filtered by it before `fromJSON`
            // opens their windows, and the grid is swept by it afterwards.
            // Read BEFORE the restore for that reason — a second spelling of
            // this rule, or a second moment for it, is the bug.
            //
            //  * session cards that still have a persisted record stay (they
            //    resume-on-focus); one with no record behind it goes.
            //  * diff panes and document viewers are DERIVED — always dropped,
            //    the user reopens them. "Restoring open viewers across
            //    relaunch" is named in E16's *Not in scope*, and a viewer
            //    restored blind would also re-read a file whose folder may no
            //    longer be in the read scope.
            // #650, and the same distinction as `groupIds` above: `.map` on
            // the brand throws, but degrading to an EMPTY set would be worse
            // than the throw — it says "no card has a record" and prunes every
            // session panel out of the restored layout. `null` says "we could
            // not ask", and prunes no session. Derived panels are dropped
            // either way: that verdict never depended on the answer.
            const cardRecords = answered(await window.switchboard.sessions.knownCards());
            const known = cardRecords ? new Set(cardRecords.map((c) => c.cardId)) : null;
            const willBePruned = (panelId: string): boolean => {
              const s = /^session-(.+)$/.exec(panelId);
              return isDerivedPanelId(panelId) || (!!s && known !== null && !known.has(s[1]));
            };
            // popouts persist in the layout, but their stored url has last
            // launch's (random) loopback port and their position may be on a
            // now-missing monitor — fix both before restoring (E8-02)
            // #650: an empty list makes `sanitizePopoutLayout` skip the
            // rescue entirely (it guards on `workAreas.length > 0`), so a
            // refusal moves no window rather than moving all of them on the
            // strength of a display list we never received.
            //
            // NOTE THE ASYMMETRY with `revealNow`, which degrades the same
            // refusal to `[]` and thereby DOES rescue (an empty list makes
            // `boxOnAnyDisplay` false, so the remembered rect is dropped and
            // the window opens over the opener). Neither is a copy of the
            // other's mistake: both fall onto the behaviour their own callee
            // already had for an empty display list, and that behaviour differs
            // because `sanitizePopoutLayout` guards on length and
            // `boxOnAnyDisplay` does not. Restoring a whole saved layout is
            // also the wrong moment to relocate every popout on a non-answer,
            // where reopening one card's window is cheap to get wrong.
            const workAreas = answered(await window.switchboard.workAreas()) ?? [];
            const rescuedNow: RescuedPopout[] = [];
            // ...and no popout window is restored holding a panel that verdict
            // condemns (#494): a window left with nothing is not opened at all,
            // and one that survives comes back without those tabs. Opening a
            // window only to empty it races dockview's deferred popout
            // restoration and strands it on screen. FIRST, so a window we are
            // not reopening is never offered to the reconnect prompt either.
            const sane = sanitizePopoutLayout(
              prunePopoutGroups(saved, willBePruned),
              window.location.origin,
              workAreas,
              rescuedNow
            );
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
            // #650: EVERY prune below deletes records whose card is not in
            // `known`, so a refused `knownCards` read must prune nothing at
            // all — the identical argument the group-override comment inside
            // makes for a failed group list, and the reason `known` is `null`
            // rather than an empty set.
            //
            // Named precisely, because the size of the claim is the argument:
            // presentation, policies, layout, focus policies, pins and manual
            // order all delete unconditionally, so an empty set wipes every one
            // of them for every session. The two DRAFT prunes would survive —
            // `staleDraftKeys` and `staleAttachmentDraftKeys` already return
            // early on an empty set (`composer-draft.ts`,
            // `composer-attachment-draft.ts`). That is the same hazard, spotted
            // once for the two biggest payloads and never generalised; the
            // guard here is the generalisation, and it is the only thing
            // standing between a refused read and the other six.
            if (known !== null) {
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
              // E9-10's per-session focus overrides are card-keyed and outlive
              // their cards exactly as the presentation overrides above do.
              sessionStore.pruneFocusPolicies(known);
              // and E9-09's pins, keyed the same way and outliving their cards
              // the same way.
              sessionStore.prunePins(known);
              // ...and #559's manual rail order, which names cards the same way
              // and would otherwise keep ranking sessions that no longer exist.
              sessionStore.pruneManualOrder(known);
              // ...and #485's unsent prompts. The same rule, and the one with the
              // biggest payload: a draft is whatever the user pasted.
              pruneDrafts(known);
              // and #546's half of the same draft — the NAMES of the files that
              // were attached to it, plus the retained bytes those names refer
              // to. Same key shape, same rule, so the two halves of one draft
              // cannot end up with different lifetimes.
              pruneAttachmentDrafts(known);
            }
            // The same verdict, on the grid this time. Only GRID panels reach
            // here, and that is now guaranteed rather than usual:
            // `prunePopoutGroups` (#494) already took every condemned id out of
            // the layout's popout groups. It matters because `fromJSON` builds
            // grid groups SYNCHRONOUSLY while it opens popout windows on a
            // timer — removing a panel from a popout that has not finished
            // opening strands that window on screen, empty, for ever.
            for (const p of [...api.panels]) if (willBePruned(p.id)) api.removePanel(p);
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
            // ...and every remembered slot went with it (#657) — see below.
            sessionStore.forgetSlots();
          }
        } else {
          // NO LAYOUT CAME BACK, so no remembered slot means anything any more
          // (#657). A `slot` or a `home` names a dockview group by an id that
          // is minted per grid — "1", "2", ... — and those ids only mean what
          // they meant last launch because `fromJSON` restores them with the
          // layout. Without it the grid mints from the beginning, and a
          // persisted `groupId: '2'` names whichever group happens to get there
          // first: a stranger's. `homeGroupId` and `placeAt` can both refuse an
          // id that is GONE; neither can see one that is a coincidence, so the
          // records are dropped at the moment they stopped meaning anything
          // instead of being read later and half-trusted. Nothing visible is
          // lost — with no layout there are no slots to go back to.
          sessionStore.forgetSlots();
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
        // scripted-check seam: one document viewer without the file dialog
        // (P2-E16-02). AFTER the session above, and that order is the point —
        // the seam grants nothing, so the file is only readable because its
        // folder is now an open session's folder.
        const seedDoc = window.switchboard.seedDocument;
        if (seedDoc) openDocumentPanel(api, seedDoc, props.colorScheme);
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
          onClick={() => void newSessionInGrid()}
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
