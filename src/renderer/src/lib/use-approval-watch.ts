// The clock half of lib/approval-watch (#1202): a row, a pill or a group's box
// asks "is one of mine waiting on an approval, and how long has it got?".
//
// Self-contained on purpose. The surfaces that draw the cue are fed by two
// different parents; a hook each of them calls reads the same ledger the
// approval bars read, and no prop has to be threaded through either parent.
//
// IT ONLY TICKS WHILE THERE IS A CLOCK TO READ. A row with nothing held, or
// holding only a question, arms no timer and sets no state, so a calm
// workspace pays nothing for this. And the store snapshot is the DEADLINE (a
// number), not the ledger: a row re-renders when its own clock changes, not
// whenever any session anywhere asks for something.
import React from 'react';
import { sessionStore } from '../store/session-store';
import {
  ApprovalWatch,
  approvalWatch,
  APPROVAL_URGENT_MS,
  earliestDeadline,
} from './approval-watch';

const subscribeStore = (cb: () => void): (() => void) => sessionStore.subscribe(cb);

/** how often the time left is re-read for the tooltip */
const TICK_MS = 10_000;

/**
 * Re-render on a ten-second beat while `deadline` is set, and once more
 * exactly when its last minute starts, so the quicker pulse is not up to ten
 * seconds late. Returns nothing: the caller reads the clock itself, at render,
 * so the first paint after a request arrives is already right.
 */
function useDeadlineBeat(deadline: number | null): void {
  const [, beat] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (deadline === null) return;
    const tick = setInterval(beat, TICK_MS);
    const untilUrgent = deadline - APPROVAL_URGENT_MS - Date.now();
    const edge = untilUrgent > 0 ? setTimeout(beat, untilUrgent + 50) : null;
    return () => {
      clearInterval(tick);
      if (edge) clearTimeout(edge);
    };
  }, [deadline]);
}

export function useApprovalWatch(
  /** the cards this surface speaks for that are lit AND on needs-permission */
  waitingCardIds: readonly string[]
): ApprovalWatch {
  // by value: the caller builds a fresh array each render
  const key = waitingCardIds.join('\n');
  const ids = React.useMemo(() => new Set(key === '' ? [] : key.split('\n')), [key]);
  const deadline = React.useSyncExternalStore(subscribeStore, () =>
    ids.size === 0 ? null : earliestDeadline(sessionStore.getState().pendingPermissions, ids)
  );
  useDeadlineBeat(deadline);
  return approvalWatch(ids.size > 0, deadline, Date.now());
}

/**
 * The same answer for a component that draws MANY surfaces from one render
 * (the left list draws every group header itself, in a loop, where a hook per
 * header is not possible).
 *
 * `active` is the caller saying it has something to ask about at all. The
 * left list passes "a closed group has a session waiting on an approval",
 * which is the only case its headers carry the cue; without it this would
 * re-render every row in the list every ten seconds for as long as anything
 * anywhere was held.
 */
export function useApprovalLookup(
  active: boolean
): (waitingCardIds: readonly string[]) => ApprovalWatch {
  const soonest = React.useSyncExternalStore(subscribeStore, () => {
    if (!active) return null;
    let min: number | null = null;
    for (const r of sessionStore.getState().pendingPermissions) {
      if (typeof r.deadline === 'number' && (min === null || r.deadline < min)) min = r.deadline;
    }
    return min;
  });
  useDeadlineBeat(soonest);
  return (ids) =>
    approvalWatch(
      ids.length > 0,
      ids.length > 0
        ? earliestDeadline(sessionStore.getState().pendingPermissions, new Set(ids))
        : null,
      Date.now()
    );
}
