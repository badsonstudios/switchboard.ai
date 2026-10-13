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

  private heldRequestProbe: ((sessionId: string) => boolean) | null = null;
  /** the change `ingest` declined for a session whose demand is still held;
   *  see `releaseHeld` */
  private readonly parked = new Map<string, StatusChange>();

  constructor(private readonly maxEvents = 500) {}

  /**
   * Teach the feed whether main is still holding a request for a session
   * (#1258). See `ingest` for what it is used for and why it is asked here as
   * well as in the status machine.
   */
  setHeldRequestProbe(fn: (sessionId: string) => boolean): void {
    this.heldRequestProbe = fn;
  }

  /**
   * Is this session's row a DEMAND that main is still holding a request for?
   *
   * Both halves matter. The probe alone would keep a `done` row alive for a
   * session that happened to ask again; the row alone is the old behaviour.
   * Fails open to that old behaviour: a probe that throws must not be the
   * reason a row can never leave.
   */
  private demandStillHeld(sessionId: string): boolean {
    if (!this.heldRequestProbe) return false;
    const row = this.events.find((e) => e.sessionId === sessionId && STATUS_KINDS.has(e.kind));
    if (!row || (row.kind !== 'needs-permission' && row.kind !== 'needs-input')) return false;
    try {
      return this.heldRequestProbe(sessionId) === true;
    } catch {
      return false;
    }
  }

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
    // A DEMAND MAIN IS STILL HOLDING DOES NOT LEAVE BECAUSE THE STATUS MOVED
    // (#1258).
    //
    // Every "N need you" readout counts this list: the Sessions list's
    // total, each group's own line, the strip's chip, the lit row and pill,
    // the Events panel. So "cleared without a replacement" below was the
    // line that took an approval off every one of them at once, the moment
    // the CLI streamed its next frame and the status read `working` again:
    // 51 of 305 held requests in the owner's log, with the approval bar the
    // only thing left that knew, and only if its card was on screen.
    //
    // The status machine no longer makes that move (`transition`'s `held`).
    // This is the second lock on the same door, and it is here on purpose:
    // the request being held is the FACT, the status is a report of it, and
    // a list people act on should not depend on every future writer of a
    // status getting that right.
    //
    // ONLY a move to a non-attention state is refused. `done` and `crashed`
    // still replace the row: a turn that ended, or a session that died, is
    // not waiting on an answer any more, whatever is left in the router.
    if (!ATTENTION.has(change.to) && this.demandStillHeld(change.sessionId)) {
      // remembered, so the row can leave when the request does: see `releaseHeld`
      this.parked.set(change.sessionId, change);
      return null;
    }
    this.parked.delete(change.sessionId);
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

  /**
   * A held request was answered, timed out or cancelled: apply any change
   * `ingest` declined while it was held (#1258).
   *
   * Without this the second lock could close and never open. A declined
   * move to `working` is not repeated by anyone: when the request is finally
   * answered the status is ALREADY `working`, no change is raised, and the row
   * would have sat there until the turn ended. Unreachable while the status
   * machine holds the line itself, which is exactly when a lock nobody
   * exercises goes wrong unnoticed. Found in review.
   */
  releaseHeld(): void {
    for (const [sessionId, change] of [...this.parked]) {
      if (this.demandStillHeld(sessionId)) continue; // another one is still waiting
      this.parked.delete(sessionId);
      this.ingest(change);
    }
  }

  /** A session was closed/removed — its event goes with it. */
  forget(sessionId: string): void {
    this.parked.delete(sessionId);
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
