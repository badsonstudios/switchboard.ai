// The renderer's state authority (P2-E15-07, AR-P1-4).
//
// Before this, cross-cutting renderer state lived in three different places
// and none of them were a state layer:
//
//   • module-level mutable Maps and Sets in SessionGrid.tsx — app state in
//     module scope, invisible to React and untestable without mounting a tree;
//   • a DOM CustomEvent bus (`switchboard:groups-changed`) used to nudge App
//     into re-reading, i.e. a pub/sub system built out of the window object;
//   • refs in App.tsx shadowing state, so keyboard handlers could read a value
//     React had not committed yet.
//
// THE REFS WERE RIGHT. A keydown handler runs outside React's batching, and it
// must see what is true NOW — two Ctrl+Space presses in one frame have to
// advance two steps, not batch into one. That requirement does not go away; it
// just belongs to a store with a synchronous `getState()` rather than to a pile
// of refs each component has to remember to keep in sync.
//
// Plain class + useSyncExternalStore. No new dependency: what we need is a
// synchronous read and a subscription, and that is the whole of it.
import { EventDto, RailGroup, RailSession } from '../model/types';
import { railOrder, RailOrderResult } from '../lib/groups';
import { attentionQueue, needingCards, nextInQueue, withVisit } from '../lib/queue';
import {
  CardPresentation,
  DEFAULT_PRESENTATION,
  PersistedPresentation,
  persistablePresentation,
  persistedChanged,
  prunePresentation,
  samePresentation,
} from '../lib/presentation';
import { markLit, pruneLit, startBeat, UrgencyMarks } from '../lib/urgency';
import {
  DEFAULT_BOOK,
  persistablePolicies,
  PolicyBook,
  PresentationPolicy,
  prunePolicies,
  resolvePolicy,
} from '../lib/presentation-policy';
import {
  DEFAULT_LAYOUT,
  forgetLayoutCard,
  LayoutState,
  persistableLayout,
  pruneLayout,
} from '../lib/layout-mode';
import {
  attentionEvents,
  DEFAULT_FOCUS_BOOK,
  FocusBook,
  FocusPolicy,
  persistableFocusPolicies,
  pruneFocusPolicies,
  resolveFocusPolicy,
} from '../lib/focus-policy';
import {
  chooseBatch,
  PermissionBatch,
  sameBatch,
} from '../lib/permission-batches';
import { dropRetired } from '../lib/held-permissions';
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import {
  isPinned,
  NO_PINS,
  persistablePins,
  PinSet,
  prunePins,
  togglePin,
  withPin,
} from '../lib/pinning';
import {
  ManualOrder,
  NO_ORDER,
  persistableManualOrder,
  pruneManualOrder,
  stepReorder,
  withBucketOrder,
} from '../lib/rail-order';

/**
 * A snapshot. Every field is `readonly` deliberately: identity IS the change
 * signal, so `getState().events.push(e)` would mutate live state, render
 * nothing (the reference did not change) and leave the derived queue stale.
 * Making that a compile error costs nothing at the call sites.
 */
export interface SessionState {
  /** card ids in the grid */
  readonly cards: readonly string[];
  /** the card the grid is showing */
  readonly activeCard: string | null;
  readonly sessions: readonly RailSession[];
  readonly groups: readonly RailGroup[];
  readonly events: readonly EventDto[];
  /** where the attention walk has been, BY EVENT ID (see lib/queue) */
  readonly visited: ReadonlySet<number>;
  /** per-card view tab / ladder rung / dock slot (P2-E15-08) */
  readonly presentation: ReadonlyMap<string, CardPresentation>;
  /**
   * The delayed urgency reset (P2-E9-04, §5.8): card id -> the epoch ms at
   * which its lamp stops being lit, or `null` for a lamp that has been marked
   * but not yet painted (#320 — the beat runs from first paint). Deliberately
   * deadlines rather than a plain Set plus a timer — a deadline is a fact the
   * render can read, so the timer only has to schedule a re-render and can
   * never be the authority on what is lit. NOT persisted: "which session called
   * you 1.5 seconds ago" is not a fact a relaunch can inherit.
   */
  readonly urgency: UrgencyMarks;
  /**
   * §5.8's presentation policy (P2-E9-06): the global default plus the
   * per-group and per-session overrides. In `state` and not a registry because
   * surfaces RENDER from it — the titlebar chip, the rail's menus — while the
   * submit path has to read it synchronously from outside React's commit, which
   * is the same pair of requirements that put `presentation` here.
   */
  readonly policies: PolicyBook;
  /**
   * §5.8's focus-stealing policy (P2-E9-10): the global setting plus the
   * per-session overrides. In `state` for the same pair of reasons `policies`
   * is — the rail menu RENDERS from it, and the reveal-on-attention effect
   * reads it while deciding what an incoming event may do.
   */
  readonly focusPolicies: FocusBook;
  /**
   * §5.8's layout mode + the maximize it can be holding (P2-E9-07). In `state`
   * for the same pair of reasons `presentation` is: the titlebar chip and the
   * palette RENDER from it, and the sweep that applies it runs from a keydown
   * handler outside React's commit and has to read what is true now.
   */
  readonly layout: LayoutState;
  /**
   * §5.8's pinning contract (P2-E9-09): the pinned CARD ids.
   *
   * In `state` rather than one of the imperative registries below because rail
   * order is DERIVED from it — a pinned session sorts first — and derived values
   * here are recomputed on mutation. It is read synchronously by the submit
   * sweep and by close-all as well, both of which run outside React's commit.
   */
  readonly pinned: PinSet;
  /**
   * The order the user arranged the rail into by hand (#559), per bucket.
   *
   * In `state` for the same reason `pinned` is, and it is the same sentence:
   * rail order is DERIVED from it, and derived values here are recomputed on
   * mutation. It is read synchronously by the reorder commands too, which run
   * from a keydown handler outside React's commit.
   */
  readonly manualOrder: ManualOrder;
  /**
   * Every permission request main is currently holding, ACROSS every session
   * (P2-E9-11, §5.8's batch bullet).
   *
   * The cards already keep their own copies — `SessionCardPanel`'s `permQueue`,
   * one per card, each filtered to its own `cardId`. This is not a second
   * authority over those: it is the first place anything in the renderer can
   * see the requests TOGETHER, which is the one thing a grouped prompt needs
   * and a per-card queue can never provide. Main is the authority over both,
   * and both are fed by the same three primitives (`permissionRequest`,
   * `permissionResolved`, and the `pendingPermissions` replay).
   *
   * It has to be a whole-fleet view for a second reason: dockview mounts only
   * the panels it is showing, so the card holding the sibling question usually
   * is not mounted at all. Its request exists in main and in nothing on screen.
   *
   * In `state` and not one of the imperative registries below because a surface
   * RENDERS from it — that is the same test `policies` and `pinned` pass.
   */
  readonly pendingPermissions: readonly PermissionRequestDto[];
}

const EMPTY: SessionState = {
  cards: [],
  activeCard: null,
  sessions: [],
  groups: [],
  events: [],
  visited: new Set(),
  presentation: new Map(),
  urgency: new Map(),
  policies: DEFAULT_BOOK,
  focusPolicies: DEFAULT_FOCUS_BOOK,
  layout: DEFAULT_LAYOUT,
  pinned: NO_PINS,
  manualOrder: NO_ORDER,
  pendingPermissions: [],
};

/** The "no batch" snapshot, once. `useSyncExternalStore` compares by identity,
 *  so a fresh `new Set()` per read would re-render every subscriber forever. */
const NO_BATCHED_IDS: ReadonlySet<string> = new Set();

/**
 * Do two not-started rows (#687) say the same thing?
 *
 * Only the four fields `markCardNotStarted` fills are compared, because they
 * are the only four such a row HAS — it is built from the card's own panel
 * params, not from a wire record, so there is no accent, badge, live id or
 * transport to differ in. `status` is a constant on that path and is not worth
 * a comparison that can only ever be true.
 */
function sameNotStartedRow(a: RailSession, b: RailSession): boolean {
  return a.id === b.id && a.title === b.title && a.folder === b.folder && a.groupId === b.groupId;
}

export class SessionStore {
  private state: SessionState = EMPTY;
  private listeners = new Set<() => void>();

  // Derived values are recomputed ON MUTATION, not in the selector.
  // useSyncExternalStore compares getSnapshot() by identity and loops forever
  // if it returns a fresh object each call — so a derived array has to be a
  // stored value with a stable reference, not a computation.
  private derivedRail: RailOrderResult<RailSession> = railOrder<RailSession>([], []);
  private derivedQueue: EventDto[] = [];
  // The feed minus the sessions whose focus policy is `none` (P2-E9-10) — the
  // list every queue reader works from. Kept beside the ordered queue because
  // `advanceQueue` and the visited-set prune need the UNORDERED subset, and
  // recomputing the filter at each of those call sites is how two of them end
  // up disagreeing about which sessions are silenced.
  private derivedAttention: readonly EventDto[] = [];
  // The cards every "N need you" readout counts (#621) — one per session with
  // an outstanding item in the Events window.
  //
  // Derived from the RAW feed, not from `derivedAttention`: `lib/focus-policy`
  // states in as many words that a `none` session's rail row, lamp and "N need
  // you" count keep reporting it, because `none` silences the WORKSPACE
  // response, not the session's existence. Filtering here would make a held
  // permission invisible rather than quiet — §4's fail-open rule.
  private derivedNeeding: ReadonlySet<string> = new Set();
  // §5.8's batch prompt (P2-E9-11): the ONE group currently on screen, and the
  // request ids it has taken responsibility for. Derived on mutation like the
  // rest, and — unlike the rest — deliberately identity-STABLE across a
  // recompute that changes nothing (`sameBatch`), because a new object here
  // would replace the card the user is mid-click on.
  private derivedBatch: PermissionBatch | null = null;
  private derivedBatchedIds: ReadonlySet<string> = NO_BATCHED_IDS;

  // ── live session id -> stable card id ───────────────────────────────────
  // The rail tracks LIVE sessions; cards are the durable unit. A live id
  // churns on every resume, so this mapping is how "focus the session that
  // just asked for permission" finds a card that outlives it.
  private readonly liveToCard = new Map<string, string>();
  // LIVE session ids granted "Allow all (this session)" — keyed by the
  // ephemeral id ON PURPOSE, so a respawn prompts again (review P0#2).
  // Released with the binding that named the id (`forgetCardLiveIds`, #224):
  // the key is ephemeral but nothing used to drop it, so a grant outlived its
  // session — and its card — for the whole app run.
  private readonly allowAllByLive = new Set<string>();
  // Cards whose panel is being removed BY US to hide it, as opposed to the user
  // closing it: dockview cannot tell the difference and they mean opposite
  // things — hiding keeps the record and the running session, closing forgets
  // both (P2-E15-08).
  private readonly hidingCards = new Set<string>();
  // Cards whose panel is being MOVED by us, for a ladder change (P2-E9-05).
  // Same shape and same reason as hidingCards: dockview fires the very events a
  // user tab-drag fires, and two of our listeners act on them — one adopts the
  // new neighbours' persistent group, the other reads a popout leaving its
  // window as "the user closed it" and suspends the session. Neither is true of
  // a rung change, and presentation must never write session data.
  private readonly movingCards = new Set<string>();

  /** The current state. Synchronous and always current — that is the point. */
  getState(): Readonly<SessionState> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rail order — the numbering authority for Ctrl+1..9 AND what the rail
   *  renders, so the eye and the keyboard can never disagree. */
  getRailOrder(): RailOrderResult<RailSession> {
    return this.derivedRail;
  }

  /** The attention queue, in priority order (E9-03), minus the sessions whose
   *  focus policy silenced them (E9-10). */
  getQueue(): EventDto[] {
    return this.derivedQueue;
  }

  /** The feed events the queue may see — the log minus the `none` sessions
   *  (E9-10). What the Events panel highlights its next-up row from, so the
   *  highlight and Ctrl+Space cannot point at different rows. */
  getAttentionEvents(): readonly EventDto[] {
    return this.derivedAttention;
  }

  /**
   * The cards with an outstanding demand — what the rail's group summaries, its
   * footer and the urgency strip's aggregate all count (#621).
   *
   * A stored set with a stable identity, like every other derived value here:
   * three `useSyncExternalStore` readers compare it by reference.
   */
  getNeedingCards(): ReadonlySet<string> {
    return this.derivedNeeding;
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    // KEY presence, not truthiness: `setEvents([])` must still recompute, and
    // a future optional-param setter must not silently skip the derive
    // `pinned` is in the condition because a pinned session sorts first (E9-09):
    // rail order is a function of all three, and a pin that did not re-derive it
    // would leave the rail, Ctrl+1..9 and both strips reading last order.
    // `manualOrder` joins the condition for the reason `pinned` did: rail order
    // is a function of all four now, and an arrangement that did not re-derive
    // it would be an order the user made and the rail never painted (#559).
    if (
      'sessions' in patch ||
      'groups' in patch ||
      'pinned' in patch ||
      'manualOrder' in patch
    ) {
      this.derivedRail = railOrder(
        this.state.sessions,
        this.state.groups,
        this.state.pinned,
        this.state.manualOrder
      );
    }
    // The queue is derived from the SILENCED-FILTERED feed (P2-E9-10), so it
    // has to be recomputed when the focus book changes as well as when events
    // do: setting a session to `none` must take it off the to-do list the same
    // moment, not at the next event push.
    if ('events' in patch || 'focusPolicies' in patch) this.rederiveAttention();
    if ('pendingPermissions' in patch) this.rederiveBatch();
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        // a broken subscriber costs itself, not every other listener
        console.error('[store] subscriber threw', err);
      }
    }
  }

  /**
   * Recompute the filtered feed and the queue over it (P2-E9-10).
   *
   * THREE inputs, not two: the events, the focus book, and `liveToCard` — the
   * filter is applied per CARD, and events carry the live id. The first two live
   * in `state` and arrive through `set()`; the third is a registry deliberately
   * outside the notify path, which is why binding a live id calls this by hand.
   * Without that call a session bound AFTER its first event landed (a spawn that
   * crashes or finishes before `sessions:create` resolves) would sit in the
   * queue unfiltered until the next feed push.
   */
  private rederiveAttention(): void {
    this.derivedAttention = attentionEvents(this.state.events, (liveId) =>
      this.focusPolicyFor(this.cardIdForLive(liveId))
    );
    this.derivedQueue = attentionQueue(this.derivedAttention);
    // …and the counters' set, off the UNfiltered feed — see `derivedNeeding`.
    // Same three inputs as above, so it belongs in the same recompute: a card
    // bound after its first event landed would otherwise be counted under the
    // live id `cardIdForLive` falls back to, which no rail row carries.
    this.derivedNeeding = needingCards(this.state.events, (liveId) =>
      this.cardIdForLive(liveId)
    );
  }

  /**
   * Recompute §5.8's grouped prompt (P2-E9-11).
   *
   * Sticky on the CURRENT key, so a group already on screen keeps the card as
   * long as two sessions are still asking it — see `chooseBatch`.
   *
   * The early return is not an optimisation. The batch and the batched-id set
   * are read through `useSyncExternalStore`, which compares by identity: a new
   * object on every unrelated permission event would re-render the shell and
   * every mounted card, and would swap the grouped card's buttons for
   * identical-looking new ones between a user's read and their click.
   */
  private rederiveBatch(): void {
    const next = chooseBatch(this.state.pendingPermissions, this.derivedBatch?.key ?? null);
    if (sameBatch(next, this.derivedBatch)) return;
    this.derivedBatch = next;
    this.derivedBatchedIds = next
      ? new Set(next.members.map((m) => m.requestId))
      : NO_BATCHED_IDS;
  }

  /** The grouped prompt on screen right now, or null when nothing groups. */
  getPermissionBatch(): PermissionBatch | null {
    return this.derivedBatch;
  }

  /**
   * The requests the grouped card has taken responsibility for.
   *
   * A card's own review bar SKIPS these (`SessionGrid`), so one question is
   * asked in exactly one place. The direction of that coupling is the safe one:
   * this set only ever names requests a rendered group is holding, and it
   * empties the moment the group dissolves, so the worst a mistake here can do
   * is show a question twice. Nothing can make a held request appear nowhere.
   */
  getBatchedRequestIds(): ReadonlySet<string> {
    return this.derivedBatchedIds;
  }

  /**
   * Take one held request into the whole-fleet ledger.
   *
   * Idempotent by request id, because the two feeds overlap by design: the
   * `pendingPermissions` replay a mounting renderer asks for can race the live
   * push of the same request (E10-04 review P0#3 chose that overlap on purpose
   * — a missed push must never park the CLI).
   */
  addPendingPermission(r: PermissionRequestDto): void {
    this.addPendingPermissions([r]);
  }

  /**
   * Take a whole replay in ONE write.
   *
   * The `pendingPermissions` replay hands back everything main is holding, and
   * adding them one at a time would re-key the entire ledger and re-render
   * every subscriber once per request — a fleet coming back from a reload
   * paying N full renders for one answer that has not changed since the first.
   *
   * A duplicate is dropped, because the two feeds overlap BY DESIGN: the replay
   * races the live push of the same request (E10-04 review P0#3 chose that
   * overlap on purpose — a missed push must never park the CLI). Dropped with
   * one exception — a copy that carries a `cardId` the held one lacks WINS.
   * Main stamps the card id from `cardOfLive` at send time, so a push that beat
   * the binding carries none, and keeping the older copy would leave that
   * member reading "unnamed session" for the rest of the run.
   *
   * That last sentence is now DEFENSIVE rather than descriptive (#333). Main
   * binds the card in the same synchronous stretch that spawns the session, and
   * as of #333 a stream request for an unbound session is declined outright
   * rather than pushed — so a push with no `cardId` should no longer be
   * reachable at all. The rule stays because it costs one comparison and is the
   * right answer if that ever changes; do not read it as evidence that the race
   * exists. `permission-batches.sameBatch` carries the same wording and the same
   * caveat.
   */
  addPendingPermissions(incoming: readonly PermissionRequestDto[]): void {
    let next = this.state.pendingPermissions;
    for (const r of incoming) {
      const at = next.findIndex((p) => p.requestId === r.requestId);
      if (at < 0) {
        next = [...next, r];
      } else if (next[at].cardId === undefined && r.cardId !== undefined) {
        next = next.map((p, i) => (i === at ? r : p));
      }
    }
    if (next === this.state.pendingPermissions) return;
    this.set({ pendingPermissions: next });
  }

  /** Answered, released, or timed out — main said so. */
  removePendingPermission(requestId: string): void {
    const next = this.state.pendingPermissions.filter((p) => p.requestId !== requestId);
    if (next.length === this.state.pendingPermissions.length) return;
    this.set({ pendingPermissions: next });
  }

  /**
   * The session died; its questions die with it (#239).
   *
   * The same rule the cards apply, through the same function, for the reason
   * `dropRetired`'s docblock gives: main's release is explicitly best-effort,
   * and a ledger whose only correction comes from another process cannot repair
   * itself when that correction is what went missing. A grouped card holding a
   * dead session's question would offer an Allow that decides nothing and count
   * a session that is gone.
   */
  dropPendingPermissionsForLive(retiredLiveId: string): void {
    const next = dropRetired(this.state.pendingPermissions, retiredLiveId);
    if (next === this.state.pendingPermissions) return;
    this.set({ pendingPermissions: next });
  }

  setCards(cards: string[]): void {
    this.set({ cards });
  }
  setActiveCard(activeCard: string | null): void {
    this.set({ activeCard });
  }
  /** What `sessions:cards` last reported — main's half of `state.sessions`. */
  setSessions(sessions: RailSession[]): void {
    this.rawSessions = sessions;
    this.publishSessions();
  }
  setGroups(groups: RailGroup[]): void {
    this.set({ groups });
  }

  // ── cards main has never heard of (#687) ──────────────────────────────────
  //
  // `state.sessions` is a JOIN, and this is the half that does not come off the
  // wire. A card is minted in the renderer — `addSessionCardTo` generates the
  // id and adds the dockview panel — and main only learns of it when
  // `sessions:create` gets as far as `persist.upsert`, which sits AFTER the
  // spawn. Every refusal returns before it: bad input, an empty card id, a
  // folder that is not a directory, and a spawn that threw. So the card is on
  // screen, drawing #355's "Session didn't start" overlay, and `sessions:cards`
  // — built from `persist.list()` — cannot list it.
  //
  // That absence was not one missing row. `getRailOrder().flat` feeds
  // `layoutCards()`, so the card was invisible to `heldMaximize` (maximize and
  // Ctrl+Shift+M declined to rearrange around it), to Ctrl+1..9, to the
  // collapsed strip, to pinning and to close-all — while `docs/manual`
  // called the Sessions list "the complete inventory".
  //
  // WHY THE RENDERER AND NOT MAIN. The one-line alternative was to move
  // `persist.upsert` above the spawn so every card gets a record. It was
  // rejected for three reasons: a never-started card would then survive a
  // relaunch (today the `knownCards` sweep in `SessionGrid`'s `onReady` prunes
  // a restored panel with no record, deliberately); it edits the stretch of
  // `sessions:create` whose comments say three times that nothing may yield
  // inside it; and it breaks main's invariant that a persisted record means a
  // session really ran.
  private rawSessions: readonly RailSession[] = [];
  private notStarted: ReadonlyMap<string, RailSession> = new Map();

  /**
   * Main's list plus the cards only this window knows about.
   *
   * THE FILTER IS THE LOAD-BEARING LINE, and it is not defensive coding. A
   * card that was persisted by an EARLIER successful start and whose folder has
   * since gone reaches `startFailed` on the next look at it — `sessions:create`
   * refuses "folder is not a directory" — so it is marked here while ALSO being
   * in main's list, where it reads 'suspended'. Without the filter that card
   * gets two rows in the rail, two entries in `layoutCards()`, and two Ctrl+1..9
   * positions. Main wins: it has the accent, the badge, the group and the real
   * status, and this half has a title and a folder.
   *
   * IT IS ALSO WHAT MAKES `status === 'not-started'` MEAN SOMETHING DOWNSTREAM.
   * A row leaves here carrying that status only when main has no record of the
   * card, so `SessionsRail` can read the status off its props and know it is
   * looking at a card whose main-side actions would silently do nothing —
   * without asking the store, and without a second copy of this rule.
   * Self-correcting for the same reason: a retry that succeeds puts the card in
   * main's list, and this filter stops publishing our row from the next
   * `sessions:cards` refresh, whether or not anything cleared the mark.
   *
   * WHAT THE MINTED ROW DOES NOT CARRY, deliberately: an accent, a badge and an
   * `autoKey`. The first two are main's to assign at spawn — there is no
   * session to assign them for — and the rail already falls back to the neutral
   * edge for a row without one. The `autoKey` is the interesting absence: main
   * resolves it from the folder's git root (`sessions:cards` awaits `repoRoot`
   * per card), so a not-started card sits in Ungrouped rather than in the
   * emergent per-repo group its folder belongs to. Left that way on purpose —
   * the renderer has no route to a git root, and inventing a second answer to
   * "which repo is this" is how two surfaces start disagreeing about grouping.
   * An explicit `groupId` IS carried, because the card was told one.
   */
  private publishSessions(): void {
    if (this.notStarted.size === 0) {
      // the overwhelmingly common case — no copy, and `sessions` keeps the
      // identity `setSessions` handed us
      this.set({ sessions: this.rawSessions });
      return;
    }
    const known = new Set(this.rawSessions.map((s) => s.id));
    const extra = [...this.notStarted.values()].filter((s) => !known.has(s.id));
    this.set({ sessions: extra.length === 0 ? this.rawSessions : [...this.rawSessions, ...extra] });
  }

  /**
   * This card's `sessions:create` was refused — give it a row anyway (#687).
   *
   * Idempotent by VALUE, not merely by key: the lazy-spawn effect can re-run,
   * and re-publishing an identical row would hand `useSyncExternalStore` a new
   * array every time.
   */
  markCardNotStarted(card: { id: string; title: string; folder?: string; groupId?: string }): void {
    const prior = this.notStarted.get(card.id);
    const row: RailSession = { ...card, status: 'not-started' };
    if (prior && sameNotStartedRow(prior, row)) return;
    // ...and nor is a mark the dedupe would swallow whole: main already lists
    // this card, so publishing would rebuild the rail order and notify every
    // subscriber for a list that cannot change. The MARK still has to be
    // recorded — `setSessions` can drop the card later — which is why this
    // returns after the write rather than before it, and why it is a second
    // early-out rather than a clause on the one above.
    const swallowed = this.rawSessions.some((s) => s.id === card.id);
    const next = new Map(this.notStarted);
    next.set(card.id, row);
    this.notStarted = next;
    if (!swallowed) this.publishSessions();
  }

  /**
   * It started, or it is gone — either way this row is no longer ours to draw.
   *
   * Called from the successful `sessions:create` branch, from both card-close
   * paths (`onDidRemovePanel` and `retireCard`'s panel-less branch), and it is
   * safe to call for a card that was never marked, which is why none of them
   * tests first.
   */
  clearCardNotStarted(cardId: string): void {
    if (!this.notStarted.has(cardId)) return;
    const next = new Map(this.notStarted);
    next.delete(cardId);
    this.notStarted = next;
    this.publishSessions();
  }

  /**
   * One card's task label, from main's push (P2-E7-06).
   *
   * A targeted patch rather than a re-read of `sessions:cards`: the label is the
   * only field that moved, and a refresh would resolve a git root per card every
   * time the CLI revised a title. Unknown cards are ignored — a push for a card
   * this window has not listed yet is answered by the list itself when it
   * arrives, and inventing a row from one field would put a session with no
   * title, folder or status in the rail.
   *
   * PATCHES THE RAW LIST, not `state.sessions` (#687). The published list is a
   * join now, and writing the joined array back as the raw one would bake every
   * not-started row into main's half — where the next `setSessions` could no
   * longer replace it and the dedupe above could no longer see it. A label only
   * ever arrives for a card main knows, so the miss is not a case to handle.
   */
  setTaskLabel(cardId: string, taskLabel: string | undefined): void {
    const i = this.rawSessions.findIndex((s) => s.id === cardId);
    if (i < 0 || this.rawSessions[i].taskLabel === taskLabel) return;
    const sessions = [...this.rawSessions];
    sessions[i] = { ...sessions[i], taskLabel };
    this.rawSessions = sessions;
    this.publishSessions();
  }
  /** Replace the event list (a push from main, or the initial list). */
  setEvents(events: EventDto[]): void {
    this.feedDelivered = true;
    this.set({ events });
  }

  // Has the feed ever handed us a list? NOT the same as `events.length > 0`:
  // the store starts with an empty array, and E9-05's reveal-on-attention has
  // to tell "the feed has not spoken yet" from "the feed says nothing is
  // waiting". Getting that wrong makes the FIRST real list look like a burst of
  // new events and unfolds every session that was blocked when you quit
  // (P2-E9-05 review, blocker 2). Outside the notify path — nothing renders
  // from it; the events array's own identity change is what re-runs readers.
  private feedDelivered = false;
  hasFeed(): boolean {
    return this.feedDelivered;
  }

  /** Mark an event visited by the walk, so the panel's cursor tracks it. */
  visit(eventId: number): void {
    this.set({ visited: withVisit(this.state.visited, this.derivedAttention, eventId) });
  }

  /**
   * Advance the attention walk one step and return where to go.
   *
   * Reads and writes `visited` SYNCHRONOUSLY. Two presses in one frame must
   * advance two steps: if this waited for a React commit between them, the
   * second press would recompute from the same visited set and hand back the
   * same session. That is the entire reason this is a store and not useState.
   */
  advanceQueue(): EventDto | null {
    const { next, visited } = nextInQueue(this.derivedAttention, this.state.visited);
    // an empty queue is a no-op: nextInQueue still hands back a fresh Set, and
    // storing it would re-render the whole App on every dead press
    if (!next && visited.size === 0 && this.state.visited.size === 0) return null;
    this.set({ visited });
    return next;
  }

  // ── presentation (P2-E15-08) ────────────────────────────────────────────
  // Part of `state`, unlike the registries below: cards RENDER from this, and
  // E9-07's layout modes will drive every card's rung at once.
  //
  // Persistence is INJECTED rather than imported. The store writing to the ui
  // blob directly would put the preload bridge on its dependency path, and the
  // point of P2-E15-07 was a state layer that can be tested on its own.
  private persistPresentation: (blob: Record<string, PersistedPresentation>) => void = () => {};

  setPresentationPersister(fn: (blob: Record<string, PersistedPresentation>) => void): void {
    this.persistPresentation = fn;
  }

  /** One card's presentation. Unknown cards share ONE frozen default object,
   *  so a `useSyncExternalStore` snapshot for a card with no record is stable. */
  getPresentation(cardId: string | undefined): CardPresentation {
    return (cardId ? this.state.presentation.get(cardId) : undefined) ?? DEFAULT_PRESENTATION;
  }

  /**
   * One card's CURRENT title, or undefined if nothing here knows it (#196).
   *
   * Here rather than as a `.find()` at each call site because a card's title is
   * about to have more than one reader: it names the Session view's landmark,
   * and `PanelContext.title` offers it to every other panel that has to say
   * which session it belongs to.
   *
   * A `string | undefined` snapshot, so `useSyncExternalStore` settles it by
   * value — this is the exception to the recompute-on-mutation rule the derived
   * arrays above follow, which exists only because a fresh OBJECT per call
   * loops React forever.
   */
  getCardTitle(cardId: string | undefined): string | undefined {
    if (!cardId) return undefined;
    return this.state.sessions.find((s) => s.id === cardId)?.title;
  }

  /**
   * One card's accent colour, or undefined if this card has none (#312).
   *
   * Here for `getCardTitle`'s reason, and read by the tab strip: §5.11 says a
   * session's identity renders IDENTICALLY everywhere it appears, and the card
   * TAB was the one place that painted a grey dot for every session while the
   * card header — the same component, further down the same file — drew that
   * session's real accent on its border.
   *
   * Deliberately NOT one `getCardIdentity()` returning `{accent, badge}`: a
   * fresh object per call re-renders `useSyncExternalStore` forever. Two scalar
   * snapshots settle by value, which is the same exception `getCardTitle`
   * documents above.
   */
  getCardAccent(cardId: string | undefined): string | undefined {
    if (!cardId) return undefined;
    return this.state.sessions.find((s) => s.id === cardId)?.accent;
  }

  /** One card's language badge, or undefined. `getCardAccent`'s twin, and split
   *  from it for the reason documented there. */
  getCardBadge(cardId: string | undefined): string | undefined {
    if (!cardId) return undefined;
    return this.state.sessions.find((s) => s.id === cardId)?.badge;
  }

  /** Seed the map from the ui blob at boot. Does not persist — it just read it. */
  initPresentation(map: ReadonlyMap<string, CardPresentation>): void {
    this.set({ presentation: new Map(map) });
  }

  setPresentation(cardId: string | undefined, patch: Partial<CardPresentation>): void {
    if (!cardId) return; // a panel with no card id has no durable identity
    const cur = this.getPresentation(cardId);
    const next: CardPresentation = Object.freeze({ ...cur, ...patch });
    // a no-op write must not publish a new object: slots are recaptured on
    // every layout change, and identity is what tells React to re-render
    if (samePresentation(cur, next)) return;
    const map = new Map(this.state.presentation);
    map.set(cardId, next);
    this.set({ presentation: map });
    if (persistedChanged(cur, next)) this.persistPresentation(persistablePresentation(map));
  }

  isHidden(cardId: string | undefined): boolean {
    return this.getPresentation(cardId).ladder === 'hidden';
  }

  /** The card is gone for good — retire its record at that moment rather than
   *  waiting for the next boot's prune. */
  forgetPresentation(cardId: string): void {
    if (!this.state.presentation.has(cardId)) return;
    const map = new Map(this.state.presentation);
    map.delete(cardId);
    this.set({ presentation: map });
    this.persistPresentation(persistablePresentation(map));
  }

  /**
   * Forget every card's remembered `slot` and `home` — the LAYOUT did not come
   * back (#657).
   *
   * A slot names a dockview group by its id, and those ids are minted per
   * dockview instance ("1", "2", ...). While the saved layout restores they
   * round-trip with it and a remembered id means what it meant last launch. If
   * it does NOT restore — nothing was saved, or `fromJSON` threw on a corrupt
   * blob — the grid starts minting from the beginning, and a persisted
   * `groupId: '2'` now names a group that belongs to somebody else entirely.
   * `homeGroupId`/`placeAt` can refuse an id that is GONE; neither can see a
   * live id that is a coincidence.
   *
   * So the records are dropped at exactly the moment they stopped meaning
   * anything, rather than read later and half-trusted. The user loses nothing
   * they can see: without the layout there are no slots to go back to.
   */
  forgetSlots(): void {
    let changed = false;
    const map = new Map(this.state.presentation);
    for (const [cardId, p] of map) {
      if (!p.slot && !p.home) continue;
      map.set(cardId, Object.freeze({ ...p, slot: null, home: null }));
      changed = true;
    }
    if (!changed) return;
    this.set({ presentation: map });
    this.persistPresentation(persistablePresentation(map));
  }

  /** Forget records for cards that no longer exist (called after boot, when the
   *  known-card list is in). */
  prunePresentation(knownCardIds: Iterable<string>): void {
    const next = prunePresentation(this.state.presentation, knownCardIds);
    if (!next) return;
    this.set({ presentation: next });
    this.persistPresentation(persistablePresentation(next));
  }

  // ── presentation policy (P2-E9-06) ──────────────────────────────────────
  // Persistence is INJECTED, exactly as it is for presentation above: the store
  // writing to the ui blob directly would put the preload bridge on its
  // dependency path, and the point of P2-E15-07 was a state layer testable on
  // its own.
  private persistPolicies: (blob: Record<string, unknown> | null) => void = () => {};

  setPolicyPersister(fn: (blob: Record<string, unknown> | null) => void): void {
    this.persistPolicies = fn;
  }

  getPolicies(): PolicyBook {
    return this.state.policies;
  }

  /** Seed the book from the ui blob at boot. Does not persist — it just read it. */
  initPolicies(book: PolicyBook): void {
    this.set({ policies: book });
  }

  /** Replace the book (the pure edits live in lib/presentation-policy). */
  setPolicies(book: PolicyBook): void {
    if (book === this.state.policies) return;
    this.set({ policies: book });
    this.persistPolicies(persistablePolicies(book));
  }

  /**
   * The policy governing this card, overrides resolved.
   *
   * The card's persistent GROUP is looked up here rather than passed in, so
   * every caller — the submit path, the rail menu's tick, a future layout mode —
   * gets the same answer without each one remembering that groups are a level.
   * `sessions` is the rail's own list, which is where card membership lives; a
   * card whose rail entry has not landed yet therefore resolves as ungrouped.
   * Unreachable from the submit path (submitting needs a mounted card, which
   * needs the list), but worth knowing before adding a second caller.
   */
  policyFor(cardId: string | undefined): PresentationPolicy {
    const groupId = cardId
      ? this.state.sessions.find((s) => s.id === cardId)?.groupId
      : undefined;
    return resolvePolicy(this.state.policies, cardId, groupId);
  }

  /** Forget overrides for cards and groups that no longer exist. Called from
   *  the same place `prunePresentation` is, and for the same reason. */
  prunePolicies(knownCardIds: Iterable<string>, knownGroupIds: Iterable<string>): void {
    const next = prunePolicies(this.state.policies, knownCardIds, knownGroupIds);
    if (!next) return;
    this.set({ policies: next });
    this.persistPolicies(persistablePolicies(next));
  }

  // ── focus-stealing policy (P2-E9-10) ────────────────────────────────────
  // Same shape as the presentation policy above, and injected persistence for
  // the same reason. One level fewer (global + per-session, no groups) because
  // §5.8 specifies exactly that for this setting.
  private persistFocusPolicies: (blob: Record<string, unknown> | null) => void = () => {};

  setFocusPolicyPersister(fn: (blob: Record<string, unknown> | null) => void): void {
    this.persistFocusPolicies = fn;
  }

  getFocusPolicies(): FocusBook {
    return this.state.focusPolicies;
  }

  /** Seed the book from the ui blob at boot. Does not persist — it just read it. */
  initFocusPolicies(book: FocusBook): void {
    this.set({ focusPolicies: book });
  }

  /** Replace the book (the pure edits live in lib/focus-policy). */
  setFocusPolicies(book: FocusBook): void {
    if (book === this.state.focusPolicies) return;
    this.set({ focusPolicies: book });
    this.persistFocusPolicies(persistableFocusPolicies(book));
  }

  /** The focus policy governing this card, its override resolved. */
  focusPolicyFor(cardId: string | undefined): FocusPolicy {
    return resolveFocusPolicy(this.state.focusPolicies, cardId);
  }

  /** Forget overrides for cards that no longer exist. Called from the same
   *  place `prunePresentation` is, and for the same reason. */
  pruneFocusPolicies(knownCardIds: Iterable<string>): void {
    const next = pruneFocusPolicies(this.state.focusPolicies, knownCardIds);
    if (!next) return;
    this.set({ focusPolicies: next });
    this.persistFocusPolicies(persistableFocusPolicies(next));
  }

  // ── layout mode (P2-E9-07) ──────────────────────────────────────────────
  // Persistence is INJECTED, exactly as it is for presentation and policies
  // above, and for the same reason: the store must not have the preload bridge
  // on its dependency path (P2-E15-07).
  private persistLayout: (blob: Record<string, unknown> | null) => void = () => {};

  setLayoutPersister(fn: (blob: Record<string, unknown> | null) => void): void {
    this.persistLayout = fn;
  }

  getLayout(): LayoutState {
    return this.state.layout;
  }

  /** Seed from the ui blob at boot. Does not persist — it just read it. */
  initLayout(layout: LayoutState): void {
    this.set({ layout });
  }

  /** Replace the layout state (the pure edits live in lib/layout-mode). */
  setLayout(layout: LayoutState): void {
    if (layout === this.state.layout) return;
    this.set({ layout });
    this.persistLayout(persistableLayout(layout));
  }

  /** Forget a maximize (and its snapshot) whose card is gone. Called from the
   *  same place `prunePresentation` is, and for the same reason. */
  pruneLayout(knownCardIds: Iterable<string>): void {
    this.writeLayout(pruneLayout(this.state.layout, knownCardIds));
  }

  /** The card is gone for good — retire its layout records at that moment
   *  rather than waiting for the next boot's prune, exactly as
   *  `forgetPresentation` does and at the same call sites. */
  forgetLayoutCard(cardId: string): void {
    this.writeLayout(forgetLayoutCard(this.state.layout, cardId));
  }

  private writeLayout(next: LayoutState | null): void {
    if (!next) return; // nothing stale: no write, no re-render
    this.set({ layout: next });
    this.persistLayout(persistableLayout(next));
  }

  // ── pinning (P2-E9-09) ──────────────────────────────────────────────────
  // Persistence is INJECTED, exactly as it is for presentation, policies and
  // layout above, and for the same reason: the store must not have the preload
  // bridge on its dependency path (P2-E15-07). The rules are lib/pinning's.
  private persistPins: (blob: string[] | null) => void = () => {};

  setPinPersister(fn: (blob: string[] | null) => void): void {
    this.persistPins = fn;
  }

  getPins(): PinSet {
    return this.state.pinned;
  }

  /** Is this card pinned? Delegated to lib/pinning rather than asking the Set
   *  directly, so "pinned" has ONE definition — the exemptions all reach it
   *  through here or through the same function. */
  isPinned(cardId: string | undefined): boolean {
    return isPinned(this.state.pinned, cardId);
  }

  /** Seed from the ui blob at boot. Does not persist — it just read it. */
  initPins(pins: PinSet): void {
    this.set({ pinned: pins });
  }

  /** Pin or unpin one card — §5.8's one gesture, both ways. A no-op is skipped
   *  entirely: `withPin` hands the same set back, and re-deriving rail order
   *  over it would re-render every row for nothing. */
  setPinned(cardId: string, pinned: boolean): void {
    this.writePins(withPin(this.state.pinned, cardId, pinned));
  }

  togglePin(cardId: string): void {
    this.writePins(togglePin(this.state.pinned, cardId));
  }

  /** The card is gone for good — retire its pin at that moment rather than
   *  waiting for the next boot's prune, exactly as `forgetPresentation` does
   *  and at the same call sites. */
  forgetPin(cardId: string): void {
    this.setPinned(cardId, false);
  }

  /** Forget pins for cards that no longer exist. Called from the same place
   *  `prunePresentation` is, and for the same reason. */
  prunePins(knownCardIds: Iterable<string>): void {
    const next = prunePins(this.state.pinned, knownCardIds);
    if (next) this.writePins(next);
  }

  private writePins(next: PinSet): void {
    if (next === this.state.pinned) return;
    this.set({ pinned: next });
    this.persistPins(persistablePins(next));
  }

  // ── manual rail order (#559) ────────────────────────────────────────────
  // Persistence is INJECTED, exactly as it is for pins above and for the same
  // reason (P2-E15-07). The RULES are lib/rail-order's — including the one that
  // decides what happens when an arrangement meets a pin.
  private persistManualOrder: (blob: Record<string, string[]> | null) => void = () => {};

  setManualOrderPersister(fn: (blob: Record<string, string[]> | null) => void): void {
    this.persistManualOrder = fn;
  }

  getManualOrder(): ManualOrder {
    return this.state.manualOrder;
  }

  /** Seed from the ui blob at boot. Does not persist — it just read it. */
  initManualOrder(order: ManualOrder): void {
    this.set({ manualOrder: order });
  }

  /**
   * Record one bucket's arrangement — what a drop lands in.
   *
   * The caller hands the WHOLE resulting bucket, not a delta, because the whole
   * bucket is what a rank list has to be: a delta would leave the store
   * re-deriving a position from a list it cannot see, which is the same trap
   * `railOrder` returning `buckets` exists to close.
   */
  setBucketOrder(bucket: string, ids: readonly string[]): void {
    this.writeManualOrder(withBucketOrder(this.state.manualOrder, bucket, ids));
  }

  /**
   * Move one session a step up or down INSIDE its own group — the keyboard's
   * whole vocabulary (§5.32: a drag is never the only way to do something).
   *
   * Answers whether it moved, so the caller can announce a real change and stay
   * silent about a no-op. The rail's derived order is the list it steps in, so
   * the keyboard and the eye cannot disagree about what "up" meant — and the
   * pin rule is enforced by `stepReorder` rather than re-guessed here.
   */
  reorderSession(cardId: string, delta: -1 | 1): boolean {
    const bucket = this.derivedRail.bucketOf.get(cardId);
    if (!bucket) return false;
    const ids = this.derivedRail.buckets.get(bucket) ?? [];
    const next = stepReorder(ids, cardId, delta, this.state.pinned);
    if (!next) return false;
    this.setBucketOrder(bucket, next);
    return true;
  }

  /** Forget arrangements naming cards that no longer exist. Called from the
   *  same boot sweep `prunePins` is, and for the same reason. */
  pruneManualOrder(knownCardIds: Iterable<string>): void {
    const next = pruneManualOrder(this.state.manualOrder, knownCardIds);
    if (next) this.writeManualOrder(next);
  }

  private writeManualOrder(next: ManualOrder): void {
    if (next === this.state.manualOrder) return;
    this.set({ manualOrder: next });
    this.persistManualOrder(persistableManualOrder(next));
  }

  // ── urgency strip (P2-E9-04) ────────────────────────────────────────────
  // Part of `state`, like presentation and unlike the registries below: the
  // strip RENDERS from it, and the attention jump writes it from a keydown
  // handler that runs outside React's commit — the same synchronous-read
  // requirement that made this a store in the first place.

  /**
   * The lamp for this card just took a jump: light it, so the user can see
   * WHICH session called them after they arrive (§5.8's delayed urgency reset).
   * Takes a CARD id — a live id churns on every resume, and a lamp that went
   * dark because the session respawned would defeat the whole point.
   *
   * It does NOT start the beat — `startUrgencyBeat` does, from the paint. `now`
   * is only the sweep's clock here, and stays injectable so the rule is
   * unit-testable without a fake one.
   */
  markUrgency(cardId: string, now: number = Date.now()): void {
    if (!cardId) return;
    this.set({ urgency: markLit(this.state.urgency, cardId, now) });
  }

  /**
   * The strip has PAINTED these lamps lit — start their beat (#320, Dan
   * 2026-08-10). Called from the frame after the commit that drew them, so the
   * ~1.5s a human gets to read the lamp is 1.5s of the lamp being on the
   * screen, not 1.5s that may have been spent getting there.
   *
   * A no-op write is skipped entirely, exactly as `expireUrgency`'s is: this
   * runs after the paint of every urgency change, and most of them have nothing
   * waiting on one.
   */
  startUrgencyBeat(cardIds: Iterable<string>, now: number = Date.now()): void {
    const next = startBeat(this.state.urgency, cardIds, now);
    if (!next) return;
    this.set({ urgency: next });
  }

  /** The beat has passed — put the expired lamps out. A no-op write is skipped
   *  entirely: the strip arms a timer per lit lamp, and a stray fire must not
   *  re-render every card. */
  expireUrgency(now: number = Date.now()): void {
    const next = pruneLit(this.state.urgency, now);
    if (!next) return;
    this.set({ urgency: next });
  }

  // ── imperative registries ───────────────────────────────────────────────
  // Everything below is deliberately OUTSIDE the notify path: nothing renders
  // from it, so a write must not cost a re-render. Do not build a
  // useSyncExternalStore selector over any of it — it would never update.
  //
  // ── live-id ↔ card mapping ──────────────────────────────────────────────
  /**
   * Bind a live session to its card — and unbind whatever was bound to that
   * card before, so the invariant is ONE live id per card.
   *
   * The sweep mirrors main's reap (#187 → PR #199): a crash-respawn gives the
   * card a fresh live id, and without this the corpse's entry stayed for the
   * rest of the run — one more per crash-respawn cycle, released only when the
   * card is closed (`forgetCardLiveIds`). It is a forward map, so a leftover
   * could not misroute anything; it was unbounded growth, plus a dead id that
   * went on resolving to a live card long after main had stopped believing it.
   *
   * Sweeping here rather than at the call site is deliberate: `mapLiveToCard`
   * is the only way a binding is created, so the invariant cannot be forgotten
   * by a future second caller.
   */
  mapLiveToCard(liveId: string, cardId: string): void {
    // Re-binding the IDENTICAL pair happens on every remount over a still-
    // running session (hide/reveal, a ladder move, a pop-out): `sessions:create`
    // adopts the running session and hands back its own id (main's pass 2,
    // #187). Since #224 the sweep below releases the grant too, so it must not
    // run here — that would revoke a LIVE session's allow-all. By the
    // one-live-id-per-card invariant this method establishes, the sweep would
    // have found this entry and nothing else, so returning is equivalent for
    // the map itself.
    if (this.liveToCard.get(liveId) === cardId) return;
    // Through `forgetCardLiveIds` rather than a second loop, so "unbind this
    // card" has ONE implementation — and so a respawn releases everything else
    // keyed by the corpse's id, not just the binding.
    this.forgetCardLiveIds(cardId);
    this.liveToCard.set(liveId, cardId);
    // the silenced-feed filter is keyed by card and reads this map (E9-10)
    this.rederiveAttention();
  }
  cardIdForLive(liveId: string): string {
    return this.liveToCard.get(liveId) ?? liveId;
  }
  /**
   * Release the card's binding — and everything else keyed by the live id that
   * binding named. Since `mapLiveToCard` sweeps, there is at most one to find —
   * but it is a FORWARD map, so finding it is still a scan. Delete-while-
   * iterating is safe on a Map: an entry removed before it is reached is simply
   * never visited.
   *
   * This is the one place a BOUND live id stops being current, so it is where
   * the per-live-id registries are released (#224). Every caller has already
   * ended that session — card close, the dropLive suspend on a popout window
   * close, restart, and the respawn sweep in `mapLiveToCard`. HIDING
   * deliberately does not come through here (it keeps the record and the
   * running session), so a hidden card keeps its grant — correct, since the
   * session it was granted to is still running.
   *
   * The registries this store owns are released HERE; the ones other surfaces
   * own are told, via `subscribeLiveRetired` below (#239). #224 left that as a
   * residual — `setAllowAll` could still be handed an id this map never held,
   * because the review bar went on offering a torn-down session's question and
   * "Allow all" answered it. The signal closes that for the teardowns which come
   * through here, which is every renderer-side one; a session that dies on its
   * own never reaches this method, and the grid drops its held requests off
   * `sessions:exited` instead.
   */
  forgetCardLiveIds(cardId: string): void {
    const retired: string[] = [];
    for (const [liveId, cid] of this.liveToCard) {
      if (cid !== cardId) continue;
      this.liveToCard.delete(liveId);
      this.allowAllByLive.delete(liveId);
      retired.push(liveId);
    }
    // Batched, so the loop over `liveToCard` is finished before any subscriber
    // can re-enter this store. (With the one-live-id-per-card invariant there
    // is at most one id here, so nothing today can observe the difference —
    // this is what keeps that from becoming a constraint on the invariant.)
    for (const liveId of retired) this.notifyLiveRetired(liveId);
  }

  // ── a live session was retired (#239) ───────────────────────────────────
  //
  // The counterpart to the releases above, for state this store does NOT hold.
  // The card's held-permission queue is React state inside `SessionGrid`, and
  // it is keyed by live session id: Restart and the popout-close suspend both
  // leave that component mounted with its queue intact, so the next session's
  // review bar would open holding the corpse's question.
  //
  // A signal rather than a fifth Set here, because the queue is the grid's to
  // own — and rather than a `live === null` check at the two call sites,
  // because "this id is retired" and "I don't know this card's id yet" are
  // different states and only the first one may drop a hold. A fresh mount's
  // `pendingPermissions` replay CAN land before the spawn binds `live` (both
  // are async and neither waits for the other), and those holds must survive —
  // E10-04 review P0#3: a missed push must never park the CLI.
  //
  // Its own listener set, outside the notify path, for the same reason
  // membership and prompt-submit have one: this means "something happened",
  // not "state changed".
  private liveRetiredListeners = new Set<(liveId: string) => void>();

  subscribeLiveRetired(listener: (liveId: string) => void): () => void {
    this.liveRetiredListeners.add(listener);
    return () => this.liveRetiredListeners.delete(listener);
  }

  private notifyLiveRetired(liveId: string): void {
    for (const l of this.liveRetiredListeners) {
      try {
        l(liveId);
      } catch (err) {
        // a broken subscriber costs itself, not the rest of the teardown
        console.error('[store] live-retired subscriber threw', err);
      }
    }
    this.rederiveAttention(); // same reason as mapLiveToCard's (E9-10)
  }

  // ── allow-all, keyed by LIVE id ─────────────────────────────────────────
  setAllowAll(liveId: string): void {
    this.allowAllByLive.add(liveId);
  }
  isAllowAll(liveId: string): boolean {
    return this.allowAllByLive.has(liveId);
  }

  // ── hide vs close (P2-E15-08) ───────────────────────────────────────────
  /** Set around the removePanel call that hides a card, so the grid's
   *  onDidRemovePanel doesn't read it as the user closing the card and wipe
   *  the persisted record. Same shape as the teardown flag, per card. */
  setHiding(cardId: string, v: boolean): void {
    if (v) this.hidingCards.add(cardId);
    else this.hidingCards.delete(cardId);
  }
  isHiding(cardId: string): boolean {
    return this.hidingCards.has(cardId);
  }

  // ── our move vs the user's drag (P2-E9-05) ──────────────────────────────
  /** Set around a `moveTo` (or a reveal's addPanel) that a LADDER change is
   *  making, so the membership-adoption and popout-close listeners can tell it
   *  from a user drag. Not a rung and not persisted: it is true for the length
   *  of one dockview call. */
  setMoving(cardId: string, v: boolean): void {
    if (v) this.movingCards.add(cardId);
    else this.movingCards.delete(cardId);
  }
  isMoving(cardId: string): boolean {
    return this.movingCards.has(cardId);
  }

  // ── dockview lifecycle flags ────────────────────────────────────────────
  // Written by SessionGrid, READ BY SessionCardPanel — cross-component, which
  // is why they cannot be instance refs. Not part of `state`: nothing renders
  // from them, and a re-render per flag flip during teardown is the last thing
  // a closing window needs.
  private tearingDown = false;
  private restoringLayout = false;

  /** The window is closing: dockview disposal must NOT be read as the user
   *  closing cards, which would wipe persisted records. */
  setTearingDown(v: boolean): void {
    this.tearingDown = v;
  }
  isTearingDown(): boolean {
    return this.tearingDown;
  }
  /** A saved layout is being replayed: those group-change events are restore
   *  mechanics, not user drags — never adopt membership from them. */
  setRestoringLayout(v: boolean): void {
    this.restoringLayout = v;
  }
  isRestoringLayout(): boolean {
    return this.restoringLayout;
  }

  // ── membership changed ──────────────────────────────────────────────────
  // Replaces a DOM CustomEvent bus (`switchboard:groups-changed`) — a pub/sub
  // system built out of the window object. Its own listener set rather than
  // the general subscription, because this means "go re-read from main", not
  // "state changed": firing it on every store write would re-fetch the world
  // several times a second.
  private membershipListeners = new Set<() => void>();

  subscribeMembership(listener: () => void): () => void {
    this.membershipListeners.add(listener);
    return () => this.membershipListeners.delete(listener);
  }

  /** A grid drag changed group membership in main — the rail should re-read. */
  notifyMembershipChanged(): void {
    for (const l of this.membershipListeners) {
      try {
        l();
      } catch (err) {
        console.error('[store] membership subscriber threw', err);
      }
    }
  }

  // ── "open the MCP manager" (§5.17, #632) ────────────────────────────────
  //
  // A SIGNAL AND NOT A PROP, for the reason this store exists at all (see the
  // file header): the request comes from the composer, which dockview renders
  // inside a session panel, and the dialog is App state. Threading a callback
  // down through `SessionGrid` -> `SessionCardPanel` -> `FeedView` for one menu
  // item would put a piece of App's UI state on the props of three components
  // that have no other reason to know about it — and one of them is rendered by
  // dockview, which is what made the old refs-and-CustomEvents pile necessary
  // in the first place.
  //
  // Modelled on `membershipListeners` directly above, including its
  // fail-isolated fan-out: a throwing subscriber costs itself, not the caller.
  // Carries NO payload — which session's servers to show is a question App
  // already answers from the active card, and passing a second answer here
  // would be a second authority on "the session you are in".
  private mcpOpenListeners = new Set<() => void>();

  subscribeMcpOpen(listener: () => void): () => void {
    this.mcpOpenListeners.add(listener);
    return () => this.mcpOpenListeners.delete(listener);
  }

  /** Something typed `/mcp` — App should open the manager (§5.17). */
  notifyMcpOpenRequested(): void {
    for (const l of this.mcpOpenListeners) {
      try {
        l();
      } catch (err) {
        console.error('[store] mcp-open subscriber threw', err);
      }
    }
  }

  // ── `/model` typed in a composer (#721/#633) ────────────────────────────
  //
  // Its own signal rather than a parameter on the one above, because the two
  // carry different payloads: the MCP manager is opened for the ACTIVE card and
  // needs nothing, while the picker acts on the session the command was typed
  // in — which, with popouts and split grids, is not reliably the focused one.
  private modelOpenListeners = new Set<(liveId: string) => void>();

  subscribeModelOpen(listener: (liveId: string) => void): () => void {
    this.modelOpenListeners.add(listener);
    return () => this.modelOpenListeners.delete(listener);
  }

  /** Something typed `/model` in this LIVE session — App should open the picker. */
  notifyModelOpenRequested(liveId: string): void {
    for (const l of this.modelOpenListeners) {
      try {
        l(liveId);
      } catch (err) {
        console.error('[store] model-open subscriber threw', err);
      }
    }
  }

  // ── the user submitted a prompt (P2-E9-06) ──────────────────────────────
  //
  // §5.8's auto-minimize needs an event with two ends that cannot see each
  // other: the composer, which lives inside a dockview panel, and the grid,
  // which owns the dockview verbs that would remove that panel. Threading a
  // callback down through the panel CONTRIBUTION contract would make every
  // future panel carry a prop about layout policy; a notification here does not.
  //
  // Its own listener set rather than the general subscription, for the same
  // reason membership has one: this means "something happened", not "state
  // changed", and firing it from the render path would be a re-render per key.
  //
  // The payload is the LIVE session id — that is what the submit routes have —
  // and the listener maps it to a card, exactly as the reveal path does.
  private submitListeners = new Set<(liveSessionId: string) => void>();

  subscribePromptSubmit(listener: (liveSessionId: string) => void): () => void {
    this.submitListeners.add(listener);
    return () => this.submitListeners.delete(listener);
  }

  /** A renderer surface just sent a prompt to this session (lib/composer). */
  notifyPromptSubmitted(liveSessionId: string): void {
    for (const l of this.submitListeners) {
      try {
        l(liveSessionId);
      } catch (err) {
        // fail-open: a presentation rule must never cost the user their prompt
        console.error('[store] submit subscriber threw', err);
      }
    }
  }
}

/** The app's store. One window, one store. */
export const sessionStore = new SessionStore();
