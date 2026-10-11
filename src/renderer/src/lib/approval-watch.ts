// A held approval has a deadline, and nothing in the list said so (#1202).
//
// The owner: "our approvals time out". Main holds a permission request for
// five minutes and then DECLINES it, telling the session nobody answered; five
// of them ran out unseen in one day while he was using the app. The list of sessions
// showed a steady yellow pill for the whole five minutes, the same pill at
// second 1 and second 299.
//
// This is the pure half: which sessions are waiting on an APPROVAL (as opposed
// to a question, which waits for ever and has no clock), how long each has
// left, and when that becomes "nearly out". The treatment itself is CSS, keyed
// on the two attributes `approvalAttrs` returns.
//
// WHO IS WAITING is not decided here. It is `attentionPaint`'s answer (#1137),
// the same one every "N need you" count reads, so the pulse can never claim an
// approval the rest of the app has stopped listing. This module only adds the
// clock to a session that rule has already lit.
import type { TFunction } from 'i18next';
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';

/** "none of mine": one stable array, so a calm row's hook input never changes */
export const NO_CARDS: readonly string[] = Object.freeze([]);

/** The last stretch of a hold, when the cue quickens. */
export const APPROVAL_URGENT_MS = 60_000;

/**
 * The soonest deadline among the held requests of these cards, or null when
 * none of them has one (nothing held, or only questions).
 */
export function earliestDeadline(
  pending: readonly PermissionRequestDto[],
  cardIds: ReadonlySet<string>
): number | null {
  let soonest: number | null = null;
  for (const r of pending) {
    if (!r.cardId || !cardIds.has(r.cardId)) continue;
    if (typeof r.deadline !== 'number' || !Number.isFinite(r.deadline)) continue;
    if (soonest === null || r.deadline < soonest) soonest = r.deadline;
  }
  return soonest;
}

/**
 * Which of these sessions are waiting on an approval: lit by the count's own
 * rule (`needing`, #1137) AND on the `needs-permission` status. A session that
 * is asking a QUESTION is lit too, but nothing about it runs out.
 */
export function waitingOnApproval(
  sessions: ReadonlyArray<{ id: string; status?: string }>,
  needing: ReadonlySet<string>
): string[] {
  return sessions
    .filter((s) => needing.has(s.id) && s.status === 'needs-permission')
    .map((s) => s.id);
}

export interface ApprovalWatch {
  /** a session here is waiting on an approval right now */
  active: boolean;
  /** ...and its hold is in its last minute */
  urgent: boolean;
  /** ms until the hold runs out; null when there is no clock to show */
  leftMs: number | null;
}

export const NO_APPROVAL: ApprovalWatch = Object.freeze({
  active: false,
  urgent: false,
  leftMs: null,
});

/**
 * The state of the cue.
 *
 * `waiting` is the caller's "this row is lit AND its status is
 * needs-permission". A deadline that has already passed shows no clock and no
 * urgency: main has declined the request by then, and "0 seconds left" would
 * be a claim about something that is no longer there.
 */
export function approvalWatch(
  waiting: boolean,
  deadline: number | null,
  now: number
): ApprovalWatch {
  if (!waiting) return NO_APPROVAL;
  const left = deadline === null ? null : deadline - now;
  if (left === null || left <= 0) return { active: true, urgent: false, leftMs: null };
  return { active: true, urgent: left <= APPROVAL_URGENT_MS, leftMs: left };
}

/**
 * The time left, as a bound the tooltip can state: "less than N".
 *
 * A BOUND, NOT AN ESTIMATE, because the text is re-read every ten seconds and
 * not every second. "About 50 seconds" could be said with 31 left; "less than
 * 50 seconds" is true for the whole time it is on screen, and errs towards
 * hurrying, which is the right way for this to be wrong.
 */
export function approvalTimeLeft(leftMs: number): { unit: 'minutes' | 'seconds'; count: number } {
  if (leftMs <= APPROVAL_URGENT_MS) {
    return { unit: 'seconds', count: Math.max(10, Math.ceil(leftMs / 10_000) * 10) };
  }
  return { unit: 'minutes', count: Math.ceil(leftMs / 60_000) };
}

/** The two attributes the stylesheet keys on. `undefined` omits an attribute,
 *  so a calm row carries neither. */
export function approvalAttrs(w: ApprovalWatch): {
  'data-needs-approval': 'true' | undefined;
  'data-approval-urgent': 'true' | undefined;
} {
  return {
    'data-needs-approval': w.active ? 'true' : undefined,
    'data-approval-urgent': w.active && w.urgent ? 'true' : undefined,
  };
}

/**
 * The tooltip: that an approval is wanted, how long the app will go on holding
 * it, and what happens then. The last part matters: when the hold runs out
 * main declines the request and tells the session nobody answered, so a missed
 * approval is work the session did not do, not a prompt that is still waiting.
 */
export function approvalHint(t: TFunction, w: ApprovalWatch): string {
  if (w.leftMs === null) return t('approvalWatch.hint');
  const left = approvalTimeLeft(w.leftMs);
  return t(left.unit === 'minutes' ? 'approvalWatch.hintMinutes' : 'approvalWatch.hintSeconds', {
    count: left.count,
  });
}
