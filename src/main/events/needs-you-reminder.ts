// The needs-you cue's one repeat (#1267): once more when a minute is left on
// a held approval's clock.
//
// The owner's answer to "should it repeat?": once, with a minute to go. An
// approval is declined after five minutes with nobody answering (#319); the
// first cue said "this needs you", and this one says "and it is about to be
// thrown away". A QUESTION has no deadline (#570) — it waits for a person — so
// nothing is armed for one, and nothing repeats.
//
// ── what this file decides, and what it does not ─────────────────────────────
//
// It decides only WHEN. Whether the cue then plays is the rule's question,
// asked again at that moment through the engine (`remind`): the user may have
// gone to that session in the meantime (no sound for the card in front), left
// the app (the rule is focused-only), or switched the cue off. A timer that
// played the sound itself would be a second copy of the rule that could only
// ever be right by luck.
//
// It never ANSWERS anything and never moves the deadline: the router owns the
// hold and its clock (`sessions/stream-permissions.ts`), and this only listens.
//
// ── the request leaving early ────────────────────────────────────────────────
//
// Answered at the bar, from the Events drawer or the pop-up; denied by its own
// deadline; taken back by the CLI (`control_cancel_request`, measured on
// #1268 — an interrupt withdraws the held request); or released when its
// session is torn down. Every one of those ends in the router's
// `onPermissionResolved`, which is what `resolved` below is wired to. So "if
// the request is answered or withdrawn first, no repeat" is one subscription,
// not five.
import { errorText } from '../../shared/error-text';
import type { Logger } from '../log/logger';

/** How long before the deadline the repeat plays. The owner's "a minute". */
export const NEEDS_YOU_REPEAT_LEAD_MS = 60_000;

/** The slice of a held request this needs — `PermissionRequest` satisfies it. */
export interface HeldRequestLike {
  requestId: string;
  sessionId: string;
  /** wall-clock ms the hold runs out at; absent for a question (#570) */
  deadline?: number;
}

export interface NeedsYouReminderDeps {
  /** ask the rules again, for the needs-you action only, about this session */
  remind: (sessionId: string, requestId: string) => void;
  /** lead time before the deadline; `NEEDS_YOU_REPEAT_LEAD_MS` unless a test moves it */
  leadMs?: number;
  /** the wall clock, ms — the same clock the router stamps `deadline` with */
  now?: () => number;
  log?: Logger;
}

export class NeedsYouReminder {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: NeedsYouReminderDeps) {}

  /** How many repeats are armed (tests, and the log line on teardown). */
  get armed(): number {
    return this.timers.size;
  }

  /**
   * A request was just held. Arm its repeat if it has a deadline far enough
   * away to have a "minute left" at all.
   *
   * A hold shorter than the lead (only a test sets one) gets NO repeat rather
   * than an immediate one: the first cue has only just played, and a second
   * on its heels would be the same noise twice.
   */
  requested(r: HeldRequestLike): void {
    try {
      if (typeof r.deadline !== 'number' || !Number.isFinite(r.deadline)) return;
      if (this.timers.has(r.requestId)) return; // a replayed push: already armed
      const lead = this.deps.leadMs ?? NEEDS_YOU_REPEAT_LEAD_MS;
      const now = (this.deps.now ?? Date.now)();
      const delay = r.deadline - lead - now;
      if (delay <= 0) return;
      const timer = setTimeout(() => {
        this.timers.delete(r.requestId);
        try {
          this.deps.remind(r.sessionId, r.requestId);
        } catch (err) {
          // a reminder is a courtesy; it must never take anything down (P6)
          this.deps.log?.warn('the needs-you reminder threw', {
            requestId: r.requestId,
            error: errorText(err),
          });
        }
      }, delay);
      timer.unref?.();
      this.timers.set(r.requestId, timer);
    } catch (err) {
      this.deps.log?.warn('the needs-you reminder could not be armed', {
        requestId: r.requestId,
        error: errorText(err),
      });
    }
  }

  /** The request left — answered, timed out, withdrawn or torn down. No repeat. */
  resolved(requestId: string): void {
    const t = this.timers.get(requestId);
    if (!t) return;
    clearTimeout(t);
    this.timers.delete(requestId);
  }

  /** Disarm everything (app quit). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
