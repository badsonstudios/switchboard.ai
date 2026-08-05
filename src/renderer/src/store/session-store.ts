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
import { attentionQueue, nextInQueue, withVisit } from '../lib/queue';
import {
  CardPresentation,
  DEFAULT_PRESENTATION,
  PersistedPresentation,
  persistablePresentation,
  persistedChanged,
  prunePresentation,
  samePresentation,
} from '../lib/presentation';
import { markLit, pruneLit } from '../lib/urgency';
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
   * which its lamp stops being lit. Deliberately deadlines rather than a plain
   * Set plus a timer — a deadline is a fact the render can read, so the timer
   * only has to schedule a re-render and can never be the authority on what is
   * lit. NOT persisted: "which session called you 1.5 seconds ago" is not a
   * fact a relaunch can inherit.
   */
  readonly urgency: ReadonlyMap<string, number>;
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
};

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
  // Cards docking back via the pop-out BUTTON, as opposed to a bare window
  // close: the two look identical to dockview and mean opposite things (E8-04).
  private readonly dockingBackByButton = new Set<string>();
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

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    // KEY presence, not truthiness: `setEvents([])` must still recompute, and
    // a future optional-param setter must not silently skip the derive
    if ('sessions' in patch || 'groups' in patch) {
      this.derivedRail = railOrder(this.state.sessions, this.state.groups);
    }
    // The queue is derived from the SILENCED-FILTERED feed (P2-E9-10), so it
    // has to be recomputed when the focus book changes as well as when events
    // do: setting a session to `none` must take it off the to-do list the same
    // moment, not at the next event push.
    if ('events' in patch || 'focusPolicies' in patch) this.rederiveAttention();
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
  }

  setCards(cards: string[]): void {
    this.set({ cards });
  }
  setActiveCard(activeCard: string | null): void {
    this.set({ activeCard });
  }
  setSessions(sessions: RailSession[]): void {
    this.set({ sessions });
  }
  setGroups(groups: RailGroup[]): void {
    this.set({ groups });
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

  // ── urgency strip (P2-E9-04) ────────────────────────────────────────────
  // Part of `state`, like presentation and unlike the registries below: the
  // strip RENDERS from it, and the attention jump writes it from a keydown
  // handler that runs outside React's commit — the same synchronous-read
  // requirement that made this a store in the first place.

  /**
   * The lamp for this card just took a jump: keep it lit for a beat so the user
   * can see WHICH session called them after they arrive (§5.8's delayed urgency
   * reset). Takes a CARD id — a live id churns on every resume, and a lamp that
   * went dark because the session respawned would defeat the whole point.
   *
   * `now` is injectable so the rule is unit-testable without a fake clock.
   */
  markUrgency(cardId: string, now: number = Date.now()): void {
    if (!cardId) return;
    this.set({ urgency: markLit(this.state.urgency, cardId, now) });
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
   * "Bound" is the limit of the claim: nothing stops `setAllowAll` being handed
   * an id this map never held, and such an entry is still released by nothing.
   * The one path there — answering a permission the review bar kept queued
   * after its session was already torn down — is a live-session bug in its own
   * right, not something to paper over here.
   */
  forgetCardLiveIds(cardId: string): void {
    for (const [liveId, cid] of this.liveToCard) {
      if (cid !== cardId) continue;
      this.liveToCard.delete(liveId);
      this.allowAllByLive.delete(liveId);
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

  // ── dock-back disambiguation (E8-04) ────────────────────────────────────
  markDockingBack(cardId: string): void {
    this.dockingBackByButton.add(cardId);
  }
  takeDockingBack(cardId: string): boolean {
    return this.dockingBackByButton.delete(cardId);
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
