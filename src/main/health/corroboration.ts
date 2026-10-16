// The LOCAL half of "is it me or is it them?" (P2-E14-07, §5.14).
//
// Status pages lag reality — they are written by people, after someone notices.
// This machine notices first: when several INDEPENDENT sessions fail inside a
// few minutes, the common factor is not any one session, and saying so before
// the page catches up is the whole point of §5.14's corroboration bullet.
//
// It is deliberately a suspicion, not a diagnosis. The banner says "possible",
// the wording never blames the provider, and nothing in the app behaves
// differently because this is raised (fail-open: it is a sentence on a strip).

/**
 * How many DISTINCT sessions must have errored inside the window.
 *
 * Three, and the reasoning is about what each number would mean:
 *   • **1** is a session's own problem — a bad tool call, a wrong path, a
 *     prompt the model refused. Raising on one would raise constantly.
 *   • **2** is still cheaply explained by the operator: the same task run
 *     twice, the same broken repo open in two folders, one bad copy-paste.
 *   • **3** independent sessions failing within minutes of each other is the
 *     smallest count where "the thing they share" is a better explanation than
 *     "each of them separately". Below the threshold the banner would be noise,
 *     and a banner that cries wolf gets ignored on the day it is right.
 *
 * A workspace with fewer than three live sessions simply never raises this —
 * correct, not a gap: with two sessions there is no corroboration to be had,
 * and the status page is the only honest source.
 */
export const CORROBORATION_MIN_SESSIONS = 3;

/**
 * How long an error stays evidence: five minutes.
 *
 * Long enough that three sessions failing in a rolling outage land in the same
 * window (turns are minutes long, so a one-minute window would miss most real
 * events), short enough that three unrelated failures across a working morning
 * never add up. It is also about one poll of the status page, so the local
 * signal leads the page by roughly the interval it is meant to lead it by.
 */
export const CORROBORATION_WINDOW_MS = 5 * 60_000;

export interface CorroborationVerdict {
  raised: boolean;
  sessions: number;
  /** the oldest error still inside the window, ISO — only when raised */
  since?: string;
}

export interface CorroborationOptions {
  minSessions?: number;
  windowMs?: number;
}

/**
 * A sliding window of "this session errored", one entry per session.
 *
 * One entry per session, not per error: a session in a retry loop must not be
 * able to corroborate itself into a provider incident. The count this reports
 * is a count of SESSIONS, which is what the rule is about.
 */
export class CorroborationTracker {
  private readonly errors = new Map<string, number>();
  private readonly minSessions: number;
  private readonly windowMs: number;

  constructor(opts: CorroborationOptions = {}) {
    this.minSessions = opts.minSessions ?? CORROBORATION_MIN_SESSIONS;
    this.windowMs = opts.windowMs ?? CORROBORATION_WINDOW_MS;
  }

  /** This session's turn ended in an error, at `at` (ms). */
  noteError(sessionId: string, at: number): void {
    if (!sessionId) return;
    // The LATEST error wins, so a session that keeps failing keeps its evidence
    // fresh — it is one voice either way, but a live failure is not stale.
    this.errors.set(sessionId, at);
  }

  /**
   * This session's turn ended fine — it is no longer evidence of anything.
   *
   * This is the "clears when they recover" half of the done-when, and it is
   * why recovery is instant rather than waiting out the window: the moment a
   * session completes a turn, the provider answered it.
   */
  noteRecovery(sessionId: string): void {
    this.errors.delete(sessionId);
  }

  /** A session is gone (closed, or its live process exited for good). */
  forget(sessionId: string): void {
    this.errors.delete(sessionId);
  }

  /** Is the rule raised right now? Expires stale entries as it goes. */
  evaluate(now: number): CorroborationVerdict {
    let oldest = Infinity;
    for (const [id, at] of this.errors) {
      if (now - at >= this.windowMs) {
        this.errors.delete(id);
        continue;
      }
      if (at < oldest) oldest = at;
    }
    const sessions = this.errors.size;
    if (sessions < this.minSessions) return { raised: false, sessions };
    return { raised: true, sessions, since: new Date(oldest).toISOString() };
  }
}
