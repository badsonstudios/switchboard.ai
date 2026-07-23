// Event feed v1 (P1-E4-01, §5.12): the user-facing projection of session
// status changes. Only attention-worthy transitions become feed events —
// the feed answers "what needs me / what finished", not "what happened".
import { StatusChange } from '../sessions/session-manager';

export type FeedKind = 'done' | 'ready' | 'needs-input' | 'needs-permission' | 'crashed';

export interface FeedEvent {
  id: number;
  sessionId: string;
  kind: FeedKind;
  at: string;
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
   */
  ingest(change: StatusChange): FeedEvent | null {
    const removed = this.dropFor(change.sessionId);
    if (!ATTENTION.has(change.to)) {
      // cleared without a replacement (e.g. permission granted) — tell
      // subscribers the list changed so the panel drops the stale item
      if (removed) this.notify(null);
      return null;
    }
    const e: FeedEvent = {
      id: this.nextId++,
      sessionId: change.sessionId,
      kind: change.to as FeedKind,
      at: change.at,
    };
    this.events.push(e);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.notify(e);
    return e;
  }

  /** A session was closed/removed — its event goes with it. */
  forget(sessionId: string): void {
    if (this.dropFor(sessionId)) this.notify(null);
  }

  /**
   * The user looked at a finished session (clicked its event / focused it):
   * "Done." relaxes to "Ready" — still listed, no longer calling for eyes
   * (Dan 2026-07-22). Other kinds are unaffected; answering/fixing them
   * clears the item through normal status flow.
   */
  acknowledge(sessionId: string): void {
    const e = this.events.find((x) => x.sessionId === sessionId);
    if (!e || e.kind !== 'done') return;
    const ready: FeedEvent = { id: this.nextId++, sessionId, kind: 'ready', at: e.at };
    this.events[this.events.indexOf(e)] = ready;
    this.notify(ready);
  }

  private dropFor(sessionId: string): boolean {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.sessionId !== sessionId);
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
