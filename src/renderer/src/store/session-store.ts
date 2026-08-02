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

  // ── live session id -> stable card id ───────────────────────────────────
  // The rail tracks LIVE sessions; cards are the durable unit. A live id
  // churns on every resume, so this mapping is how "focus the session that
  // just asked for permission" finds a card that outlives it.
  private readonly liveToCard = new Map<string, string>();
  // LIVE session ids granted "Allow all (this session)" — keyed by the
  // ephemeral id ON PURPOSE, so a respawn prompts again (review P0#2).
  private readonly allowAllByLive = new Set<string>();
  // Cards docking back via the pop-out BUTTON, as opposed to a bare window
  // close: the two look identical to dockview and mean opposite things (E8-04).
  private readonly dockingBackByButton = new Set<string>();
  // Cards whose panel is being removed BY US to hide it, as opposed to the user
  // closing it: dockview cannot tell the difference and they mean opposite
  // things — hiding keeps the record and the running session, closing forgets
  // both (P2-E15-08).
  private readonly hidingCards = new Set<string>();

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

  /** The attention queue, in priority order (E9-03). */
  getQueue(): EventDto[] {
    return this.derivedQueue;
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    // KEY presence, not truthiness: `setEvents([])` must still recompute, and
    // a future optional-param setter must not silently skip the derive
    if ('sessions' in patch || 'groups' in patch) {
      this.derivedRail = railOrder(this.state.sessions, this.state.groups);
    }
    if ('events' in patch) {
      this.derivedQueue = attentionQueue(this.state.events);
    }
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        // a broken subscriber costs itself, not every other listener
        console.error('[store] subscriber threw', err);
      }
    }
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
    this.set({ events });
  }

  /** Mark an event visited by the walk, so the panel's cursor tracks it. */
  visit(eventId: number): void {
    this.set({ visited: withVisit(this.state.visited, this.state.events, eventId) });
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
    const { next, visited } = nextInQueue(this.state.events, this.state.visited);
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
  mapLiveToCard(liveId: string, cardId: string): void {
    this.liveToCard.set(liveId, cardId);
  }
  cardIdForLive(liveId: string): string {
    return this.liveToCard.get(liveId) ?? liveId;
  }
  forgetCardLiveIds(cardId: string): void {
    for (const [liveId, cid] of this.liveToCard) if (cid === cardId) this.liveToCard.delete(liveId);
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

}

/** The app's store. One window, one store. */
export const sessionStore = new SessionStore();
