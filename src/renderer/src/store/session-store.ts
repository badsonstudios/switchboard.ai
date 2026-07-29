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
import { PanelId } from '../extensibility/contributions';

/** Per-card imperative handles (E9-01) — how a command drives ONE card. */
export interface CardActions {
  setView: (view: PanelId) => void;
  currentView: () => PanelId;
  popOutToggle: () => void;
}

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
}

const EMPTY: SessionState = {
  cards: [],
  activeCard: null,
  sessions: [],
  groups: [],
  events: [],
  visited: new Set(),
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
  private readonly cardActions = new Map<string, CardActions>();

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

  // ── per-card imperative handles (E9-01) ─────────────────────────────────
  registerCardActions(cardId: string, actions: CardActions): () => void {
    this.cardActions.set(cardId, actions);
    return () => {
      // identity-checked: a remount registers before the old unmount runs, and
      // an unconditional delete would drop the LIVE handle
      if (this.cardActions.get(cardId) === actions) this.cardActions.delete(cardId);
    };
  }
  actionsFor(cardId: string): CardActions | undefined {
    return this.cardActions.get(cardId);
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
