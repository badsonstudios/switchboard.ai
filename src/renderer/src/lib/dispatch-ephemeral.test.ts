import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPATCH_RETIRE,
  DISPATCH_LINGER_MS,
  DISPATCH_RETIRE_KEY,
  DISPATCH_RETIRE_POLICIES,
  dispatchRetireOf,
  isDispatchRetirePolicy,
  mayRetire,
  owesAsAuthor,
  retirableReviewerCards,
  retireDelayMs,
} from './dispatch-ephemeral';
import { NO_PINS } from './pinning';
import type { EventDto } from '../model/types';
import type { DispatchOutcome } from '../../../shared/dispatch-result';

const row = (opts: {
  id?: number;
  author?: string;
  reviewer: string;
  outcome?: DispatchOutcome;
  chars?: number;
}): EventDto => ({
  id: opts.id ?? 1,
  sessionId: opts.author ?? 'author-live',
  kind: 'dispatch-result',
  at: '2026-09-26T00:00:00.000Z',
  dispatch: {
    reviewer: opts.reviewer,
    reviewerName: 'Code Reviewer of App',
    templateName: 'Code Reviewer',
    outcome: opts.outcome ?? 'reported',
    chars: opts.chars ?? 900,
    truncated: false,
  },
});

describe('the vocabulary', () => {
  it('is §5.6’s three words, with `keep` standing in for `pin`', () => {
    expect([...DISPATCH_RETIRE_POLICIES]).toEqual(['auto-close', 'linger', 'keep']);
  });

  it('defaults to `linger` — "ephemeral by default" has to actually retire', () => {
    expect(DEFAULT_DISPATCH_RETIRE).toBe('linger');
    expect(retireDelayMs(DEFAULT_DISPATCH_RETIRE)).not.toBeNull();
  });

  it('checks a stored value at runtime and falls back to the default (§5.29, fail-open)', () => {
    expect(isDispatchRetirePolicy('linger')).toBe(true);
    expect(isDispatchRetirePolicy('pin')).toBe(false);
    expect(dispatchRetireOf('auto-close')).toBe('auto-close');
    expect(dispatchRetireOf(null)).toBe(DEFAULT_DISPATCH_RETIRE);
    expect(dispatchRetireOf(7)).toBe(DEFAULT_DISPATCH_RETIRE);
  });

  it('names the ui-blob key the boot seed reads', () => {
    expect(DISPATCH_RETIRE_KEY).toBe('dispatchRetire');
  });
});

describe('retireDelayMs', () => {
  it('⚠️ DISTINGUISHES 0 FROM null — "now" is not "never"', () => {
    expect(retireDelayMs('auto-close')).toBe(0);
    expect(retireDelayMs('linger')).toBe(DISPATCH_LINGER_MS);
    expect(retireDelayMs('keep')).toBeNull();
  });

  it('lingers longer than §5.6’s 10 s watcher delay, on purpose', () => {
    expect(DISPATCH_LINGER_MS).toBeGreaterThan(10_000);
  });
});

describe('retirableReviewerCards — which cards get a timer', () => {
  const sessions = [
    { id: 'card-author', liveId: 'author-live' },
    { id: 'card-reviewer', liveId: 'reviewer-live' },
  ];
  const lineage = new Map([['card-reviewer', 'card-author']]);

  it('⭐ RETIRES ON `delivered` — the report has left the reviewer', () => {
    expect(
      retirableReviewerCards({
        events: [row({ reviewer: 'reviewer-live', outcome: 'delivered', chars: 0 })],
        sessions,
        lineage,
      })
    ).toEqual([{ cardId: 'card-reviewer', eventId: 1 }]);
  });

  it('⚠️ AND DOES NOT while the row still offers its Inject button', () => {
    // The whole safety property: a report nobody has read cannot be thrown away
    // by ephemerality. `reported` with text is the user's outstanding to-do.
    expect(
      retirableReviewerCards({
        events: [row({ reviewer: 'reviewer-live', outcome: 'reported', chars: 1200 })],
        sessions,
        lineage,
      })
    ).toEqual([]);
  });

  it('retires a `silent` reviewer — there is nothing to hand over and never will be', () => {
    expect(
      retirableReviewerCards({
        events: [row({ reviewer: 'reviewer-live', outcome: 'silent', chars: 0 })],
        sessions,
        lineage,
      })
    ).toEqual([{ cardId: 'card-reviewer', eventId: 1 }]);
  });

  it('keeps an `ended` reviewer that still HAS a report, and retires one that does not', () => {
    const kept = retirableReviewerCards({
      events: [row({ reviewer: 'reviewer-live', outcome: 'ended', chars: 400 })],
      sessions,
      lineage,
    });
    expect(kept).toEqual([]);
    const gone = retirableReviewerCards({
      events: [row({ reviewer: 'reviewer-live', outcome: 'ended', chars: 0 })],
      sessions,
      lineage,
    });
    expect(gone).toEqual([{ cardId: 'card-reviewer', eventId: 1 }]);
  });

  it('⚠️ REQUIRES A LINEAGE RECORD, so a recycled live id cannot close an ordinary card', () => {
    expect(
      retirableReviewerCards({
        events: [row({ reviewer: 'reviewer-live', outcome: 'delivered', chars: 0 })],
        sessions,
        lineage: new Map(),
      })
    ).toEqual([]);
  });

  it('ignores a reviewer whose card is already gone', () => {
    expect(
      retirableReviewerCards({
        events: [row({ reviewer: 'reviewer-live', outcome: 'delivered', chars: 0 })],
        sessions: [{ id: 'card-author', liveId: 'author-live' }],
        lineage,
      })
    ).toEqual([]);
  });

  it('names each candidate with the ROW that made it one — the verdict’s key', () => {
    // Keyed by the row and not the card, so a card SPARED for one report can be
    // asked again about a genuinely new one (a re-raise mints a new event id) while
    // the judged one stays judged. Blocker 3 of #951's review.
    expect(
      retirableReviewerCards({
        events: [row({ id: 77, reviewer: 'reviewer-live', outcome: 'delivered', chars: 0 })],
        sessions,
        lineage,
      })
    ).toEqual([{ cardId: 'card-reviewer', eventId: 77 }]);
  });

  it('never names a card twice, even when it owns two rows', () => {
    expect(
      retirableReviewerCards({
        events: [
          row({ id: 1, reviewer: 'reviewer-live', outcome: 'silent', chars: 0 }),
          row({ id: 2, reviewer: 'reviewer-live', outcome: 'delivered', chars: 0 }),
        ],
        sessions,
        lineage,
      })
    ).toEqual([{ cardId: 'card-reviewer', eventId: 1 }]);
  });

  it('ignores events that are not dispatch results', () => {
    const done: EventDto = {
      id: 5,
      sessionId: 'reviewer-live',
      kind: 'done',
      at: '2026-09-26T00:00:00.000Z',
    };
    expect(retirableReviewerCards({ events: [done], sessions, lineage })).toEqual([]);
  });
});

describe('mayRetire — asked at FIRE time, not at schedule time', () => {
  const known = new Set(['card-reviewer']);
  const base = {
    cardId: 'card-reviewer',
    pins: NO_PINS,
    policy: 'linger' as const,
    owesAsAuthor: false,
    known,
  };

  it('allows a spent, idle, unpinned card', () => {
    expect(mayRetire({ ...base, status: 'done' })).toBe(true);
  });

  it('⚠️ RE-READS THE POLICY: switching to `keep` inside the linger spares the card', () => {
    // The card counting down is exactly the card a user is looking at when they go
    // and find this setting, so a policy read only at schedule time would close it
    // seconds after being told not to.
    expect(mayRetire({ ...base, policy: 'keep', status: 'done' })).toBe(false);
    expect(mayRetire({ ...base, policy: 'auto-close', status: 'done' })).toBe(true);
  });

  it('⚠️ SPARES A PINNED CARD — §5.8’s protection contract, through `closableCards`', () => {
    expect(mayRetire({ ...base, pins: new Set(['card-reviewer']), status: 'done' })).toBe(false);
  });

  it('spares a card somebody is using again — §5.6’s "the user interacted with it"', () => {
    for (const status of ['starting', 'working', 'needs-input', 'needs-permission'] as const) {
      expect(mayRetire({ ...base, status })).toBe(false);
    }
  });

  it('spares a card that is no longer there — a close does not happen twice', () => {
    expect(mayRetire({ ...base, known: new Set(), status: 'done' })).toBe(false);
    expect(mayRetire({ ...base, cardId: '', status: 'done' })).toBe(false);
  });

  it('an unknown status is not busy — a card main never reported still retires', () => {
    expect(mayRetire({ ...base })).toBe(true);
  });

  it('⭐ SPARES A CARD THAT OWES A FINDING **AS AN AUTHOR** — the A → B → C case', () => {
    // B was dispatched by A and has handed its own report over, so it owes nothing
    // as a reviewer. But B dispatched C, and C's report is held under author B with
    // an injectable row on B's card. Closing B deletes that report AND its row.
    expect(mayRetire({ ...base, owesAsAuthor: true, status: 'done' })).toBe(false);
  });

  it('spares a card with an unsent draft in it — §5.6, in the half status cannot see', () => {
    expect(mayRetire({ ...base, hasDraft: true, status: 'done' })).toBe(false);
    expect(mayRetire({ ...base, hasDraft: false, status: 'done' })).toBe(true);
  });

  it('⚠️ SPARES A CRASHED REVIEWER — its card is the only place the reason is', () => {
    // A crash raises `ended` with nothing to inject, so the card would otherwise be
    // a candidate the moment it died. The author's row says "ended", which is enough
    // to stop waiting and not enough to act on.
    expect(mayRetire({ ...base, status: 'crashed' })).toBe(false);
  });
});

describe('owesAsAuthor — the second direction of "owes nothing"', () => {
  it('is true while a row filed under this session still offers its button', () => {
    expect(owesAsAuthor([row({ author: 'B-live', reviewer: 'C-live', chars: 900 })], 'B-live')).toBe(
      true
    );
  });

  it('is false once that row is spent, and for a row belonging to somebody else', () => {
    expect(
      owesAsAuthor(
        [row({ author: 'B-live', reviewer: 'C-live', outcome: 'delivered', chars: 0 })],
        'B-live'
      )
    ).toBe(false);
    expect(owesAsAuthor([row({ author: 'A-live', reviewer: 'B-live', chars: 900 })], 'B-live')).toBe(
      false
    );
  });

  it('a card with no live session owes nothing by construction', () => {
    expect(
      owesAsAuthor([row({ author: 'B-live', reviewer: 'C-live', chars: 900 })], undefined)
    ).toBe(false);
  });
});
