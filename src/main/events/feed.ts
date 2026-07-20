// Event feed v1 (P1-E4-01, §5.12): the user-facing projection of session
// status changes. Only attention-worthy transitions become feed events —
// the feed answers "what needs me / what finished", not "what happened".
import { StatusChange } from '../sessions/session-manager';

export type FeedKind = 'done' | 'needs-input' | 'needs-permission' | 'crashed';

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
  private listeners = new Set<(e: FeedEvent) => void>();

  constructor(private readonly maxEvents = 500) {}

  /** Wire to SessionManager.onStatusChange. Returns the feed event, if any. */
  ingest(change: StatusChange): FeedEvent | null {
    if (!ATTENTION.has(change.to)) return null;
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
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken subscriber never breaks the feed (fail-open) */
      }
    }
    return e;
  }

  list(): FeedEvent[] {
    return [...this.events];
  }

  onEvent(l: (e: FeedEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
