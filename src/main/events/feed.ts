// Event feed v1 (P1-E4-01, §5.12): the user-facing projection of session
// status changes. Only attention-worthy transitions become feed events —
// the feed answers "what needs me / what finished", not "what happened".
//
// ── AND, SINCE P2-E13-05, ONE KIND THAT IS NOT A STATUS ─────────────────────
//
// §5.12's event table has always named rows that belong to no session status —
// "Subagent started/finished", "Context handoff A → B transfer occurred", "Git:
// commit created", "Service status". `dispatch-result` is the first of them to
// be built, and building it is what forced the rule below to be stated properly
// rather than assumed.
import { StatusChange } from '../sessions/session-manager';
import type { DispatchResultDto } from '../../shared/dispatch-result';

/**
 * The kinds a row can be.
 *
 * The first five are session STATUSES (plus `ready`, which is a `done` that has
 * been looked at). `dispatch-result` is not: it is a thing that happened to
 * ANOTHER session, reported on this one's row.
 */
export type FeedKind =
  | 'done'
  | 'ready'
  | 'needs-input'
  | 'needs-permission'
  | 'crashed'
  | 'dispatch-result';

/**
 * Kinds that describe THIS session's latest attention state.
 *
 * ⚠️ THE ONE-ITEM-PER-SESSION RULE IS SCOPED TO THESE, and stating that scope is
 * the whole of what P2-E13-05 changed here. §5.12's rule reads *"one item per
 * session: the session's LATEST ATTENTION STATE. A new event from a session
 * replaces its previous one"* — and every word of it is about state. A
 * dispatch-result is not a state of the session it is filed under; it is a
 * report about a session the author dispatched. Letting the author's own next
 * status change replace it would mean the findings vanished the moment the
 * author typed anything, which is precisely when a user is most likely to type.
 *
 * So a session can carry at most one STATUS row and any number of
 * dispatch-result rows (one per dispatched session), and the two families never
 * displace each other.
 */
const STATUS_KINDS: ReadonlySet<FeedKind> = new Set<FeedKind>([
  'done',
  'ready',
  'needs-input',
  'needs-permission',
  'crashed',
]);

export interface FeedEvent {
  id: number;
  /**
   * Whose ROW this is.
   *
   * For a status kind, the session the status belongs to. For a
   * `dispatch-result`, **the AUTHOR** — #950's first done-when bullet, and the
   * point of the whole surface: a review comes back to the person who asked for
   * it, not to the card that produced it. The reviewer's own `done` is a
   * separate, ordinary row on its own card.
   */
  sessionId: string;
  kind: FeedKind;
  at: string;
  /** set on, and only on, `kind === 'dispatch-result'` */
  dispatch?: DispatchResultDto;
}

const ATTENTION: ReadonlySet<string> = new Set<FeedKind>([
  'done',
  'needs-input',
  'needs-permission',
  'crashed',
]);

export class EventFeed {
  private events: FeedEvent[] = [];
  private nextId = 1;
  private listeners = new Set<(e: FeedEvent | null) => void>();

  constructor(private readonly maxEvents = 500) {}

  /**
   * Wire to SessionManager.onStatusChange. Returns the feed event, if any.
   *
   * Semantics (Dan, 2026-07-22): ONE event per session — the session's
   * latest attention state. Any new status change REPLACES that session's
   * prior event; a non-attention change (e.g. needs-permission → working
   * after an approval) simply clears it. A `done` stays visible until the
   * session produces something newer.
   *
   * "That session's prior event" means its prior STATUS event — see
   * `STATUS_KINDS`.
   */
  ingest(change: StatusChange): FeedEvent | null {
    const removed = this.dropStatusFor(change.sessionId);
    if (!ATTENTION.has(change.to)) {
      // cleared without a replacement (e.g. permission granted) — tell
      // subscribers the list changed so the panel drops the stale item
      if (removed) this.notify(null);
      return null;
    }
    return this.add({
      sessionId: change.sessionId,
      kind: change.to as FeedKind,
      at: change.at,
    });
  }

  /**
   * A dispatched session finished — report it on the AUTHOR's row (P2-E13-05).
   *
   * One row per dispatched session: a second result from the same reviewer
   * replaces the first, because there is only ever one report being held for it
   * (`DispatchResults` spends the link on the first completion). Two different
   * reviewers reporting to one author are two rows, which is the honest count —
   * they are two findings to read and two injects to decide about.
   */
  dispatchResult(authorSessionId: string, dispatch: DispatchResultDto): FeedEvent {
    // No notification for the removal half: `add` below fires one, and `ingest`
    // makes the same choice for the same reason — a replacement is one change.
    this.dropResult(authorSessionId, dispatch.reviewer);
    return this.add({
      sessionId: authorSessionId,
      kind: 'dispatch-result',
      at: new Date().toISOString(),
      dispatch,
    });
  }

  /**
   * The row this result already has, if any — keyed by BOTH ends so a replacement
   * cannot take a different author's row for the same reviewer. (Impossible
   * today, since there is one link per dispatched session; free to make
   * impossible by construction.)
   */
  private dropResult(authorSessionId: string, reviewer: string): boolean {
    return this.drop(
      (e) =>
        e.kind === 'dispatch-result' &&
        e.sessionId === authorSessionId &&
        e.dispatch?.reviewer === reviewer
    );
  }

  /** A session was closed/removed — its event goes with it. */
  forget(sessionId: string): void {
    // EVERY row filed under it, both families: the card is gone, so there is
    // nowhere for a dispatch-result on it to be read or injected either. The
    // report itself is dropped on the same teardown by `DispatchResults.forget`.
    if (this.drop((e) => e.sessionId === sessionId)) this.notify(null);
  }

  /**
   * The user looked at a finished session (clicked its event / focused it):
   * "Done." relaxes to "Ready" — still listed, no longer calling for eyes
   * (Dan 2026-07-22). Other kinds are unaffected; answering/fixing them
   * clears the item through normal status flow.
   */
  acknowledge(sessionId: string): void {
    // THE SESSION'S STATUS ROW, not whichever of its rows comes first. With a
    // dispatch-result in the list, a plain `find` by session could land on that
    // one, see a kind that is not `done`, and return — leaving a finished
    // session calling for eyes for as long as the result sat beside it.
    const e = this.events.find((x) => x.sessionId === sessionId && STATUS_KINDS.has(x.kind));
    if (!e || e.kind !== 'done') return;
    const ready: FeedEvent = { id: this.nextId++, sessionId, kind: 'ready', at: e.at };
    this.events[this.events.indexOf(e)] = ready;
    this.notify(ready);
  }

  /**
   * The user dismissed ONE row (P2-E13-05).
   *
   * By event id, because a session can now own more than one row and
   * `forget(sessionId)` would take the lot — dismissing "your reviewer finished"
   * would silently also dismiss the author's own `needs-permission`. Unknown ids
   * are ignored: the row is already gone, and there is nobody to tell.
   */
  dismiss(eventId: number): void {
    if (this.drop((e) => e.id === eventId)) this.notify(null);
  }

  private add(body: Omit<FeedEvent, 'id'>): FeedEvent {
    const e: FeedEvent = { id: this.nextId++, ...body };
    this.events.push(e);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.notify(e);
    return e;
  }

  /** This session's STATUS row, if it had one. See `STATUS_KINDS`. */
  private dropStatusFor(sessionId: string): boolean {
    return this.drop((e) => e.sessionId === sessionId && STATUS_KINDS.has(e.kind));
  }

  private drop(match: (e: FeedEvent) => boolean): boolean {
    const before = this.events.length;
    this.events = this.events.filter((e) => !match(e));
    return this.events.length !== before;
  }

  private notify(e: FeedEvent | null): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken subscriber never breaks the feed (fail-open) */
      }
    }
  }

  list(): FeedEvent[] {
    return [...this.events];
  }

  /** Fires on ANY list change; the event is null for pure removals. */
  onEvent(l: (e: FeedEvent | null) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
