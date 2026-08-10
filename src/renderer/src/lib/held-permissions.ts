// The rule the card's held-permission queue applies when a session ends (#239).
//
// A held request is a question the CLI is BLOCKED on, and it belongs to the
// live session that asked it — an ephemeral id that churns on every restart and
// resume. The card that shows the review bar outlives that id, and the queue is
// React state inside a component that Restart and the popout-close suspend both
// leave MOUNTED. So the queue has to be told when a session stops existing, or
// the next session's bar opens holding the corpse's question: Allow decides a
// request that has already been released, and "Allow all" writes a grant keyed
// by an id no map holds — the #224 leak, one user click at a time.
//
// Here rather than inline in the effect, for the reason `pruneLit` and
// `prunePresentation` are here: the trigger belongs to React, the RULE does
// not, and a rule with no test is a rule nothing stops from drifting. Two
// triggers share it — the store's live-retired signal (a renderer-side
// teardown) and the session's own exit — and they must not be able to disagree
// about what "belongs to that session" means.
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';

/**
 * Drop everything the retired session raised, and nothing else.
 *
 * Returns the SAME array when nothing matched, so a card that has never queued
 * anything does not take a state change per teardown — the overwhelmingly
 * common case, since the store's retirement signal reaches every mounted card
 * and only one of them can own the dead session's questions.
 *
 * Keyed on the dead id and never on "not the current live id": a fresh mount
 * replays `pendingPermissions` and can land those holds before the lazy spawn
 * has bound `live` at all, and "I have not learned this card's session yet" must
 * not read as "every held request is stale" (E10-04 review P0#3 — a missed push
 * must never park the CLI).
 *
 * Takes a `readonly` list so the store's whole-fleet ledger (P2-E9-11) can apply
 * the SAME rule to the SAME event — the two must not be able to disagree about
 * what belongs to a dead session, which is the argument that put this rule in a
 * function in the first place. The returned array is the caller's to own, and
 * the unchanged case hands back the very array it was given, so the identity
 * check above still means "nothing happened".
 */
export function dropRetired<T extends { sessionId: string }>(
  queue: readonly T[],
  retiredLiveId: string
): T[] {
  const next = queue.filter((held) => held.sessionId !== retiredLiveId);
  return next.length === queue.length ? (queue as T[]) : next;
}

/**
 * One inbound `sessions:permissionRequest`, as the card receives it.
 *
 * The wire shape itself, not a hand-copy of it (#312). It used to re-declare
 * four of the DTO's fields and agreed with preload only because the same fields
 * had been typed twice; both copies were missing `reasonType`, `displayName` and
 * `suggestions`, which main has been sending since P2-E18-07.
 */
export type IncomingPermission = PermissionRequestDto;

/** One entry in the card's review queue. */
export interface HeldPermission {
  requestId: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  /** the CLI's own prose for WHY (P2-E18-07) — stream transport only */
  reason?: string;
}

/**
 * Append one request to the review queue, unless it is already there.
 *
 * Field by field, so a NEW field on the wire is a decision someone makes rather
 * than a silent pass-through — and here rather than inside the effect, because
 * that also means forgetting one is silent. `reason` was dropped exactly this
 * way once: every unit test passed and only an e2e caught it. This is the last
 * piece of the intake that a test could not reach (#310).
 *
 * The three fields the DTO gained in #312 — `reasonType`, `displayName`,
 * `suggestions` — are DECIDED here and deliberately not queued: nothing in the
 * review bar renders them today, and copying a field forward "for later" is how
 * a queue entry stops describing what the UI actually shows. They are one line
 * away the day a bar wants them, and now the type says they exist.
 *
 * Returns the SAME array on a duplicate, for `dropRetired`'s reason: a redelivery
 * (main's mount replay racing its own push) must not cost a re-render.
 */
export function enqueueHeld(
  queue: readonly HeldPermission[],
  r: IncomingPermission
): HeldPermission[] {
  if (queue.some((p) => p.requestId === r.requestId)) return queue as HeldPermission[];
  return [
    ...queue,
    {
      requestId: r.requestId,
      sessionId: r.sessionId,
      tool: r.tool,
      input: r.input,
      reason: r.reason,
    },
  ];
}

/**
 * Take ONE answered request out of the card's queue, by id.
 *
 * By id and never by position, and P2-E9-11 is why. The bar used to render
 * `permQueue[0]` and pop `slice(1)`, and those two agreed because they were the
 * same expression twice. §5.8's grouped prompt broke that: a request the batch
 * card owns is filtered out of the bar, so the head the user is answering can
 * be the SECOND entry in the raw queue — and `slice(1)` would then answer the
 * one they clicked while deleting a DIFFERENT request that is still held. Once
 * the group dissolves, that one is on no card, on no bar, and still parking its
 * CLI: the one outcome the whole batch design promises cannot happen.
 *
 * Returns the SAME array when nothing matched, like its two neighbours here, so
 * a redelivered resolution costs no render.
 */
export function dropAnswered<T extends { requestId: string }>(
  queue: readonly T[],
  answeredRequestId: string
): T[] {
  const next = queue.filter((held) => held.requestId !== answeredRequestId);
  return next.length === queue.length ? (queue as T[]) : next;
}

/**
 * Everything the card DOES with an inbound request, as ports (#310).
 *
 * The effect that used to hold this inline was untestable — SessionGrid needs a
 * live dockview to mount — and #310 is exactly the bug that hides in an
 * untestable handler: the allow-all branch answered and returned, and no test
 * could see what it skipped on the way out. Ports rather than a pure
 * `'queue' | 'auto-allow'` verdict for the same reason: the missing step WAS
 * the wiring, so a rule that returns a label and leaves the calling for the
 * effect would re-open the hole it is here to close.
 */
export interface PermissionIntake {
  /** did the user pick "Allow all (this session)" for this live session? */
  isAllowAll: (sessionId: string) => boolean;
  /** answer it now, with no bar and no user round trip */
  decide: (requestId: string, decision: 'allow') => void;
  /** open the review bar on it */
  queue: (r: IncomingPermission) => void;
  /** a question needs eyes: surface the Session tab (E10-04 review P0#5) */
  surface: () => void;
  /** hold the terminal-handoff bar off for the round trip (see below) */
  suppressHandoff: () => void;
}

/**
 * Take one inbound permission request.
 *
 * The allow-all branch is #310's point 3. It answers at once and shows nothing
 * — correct, and incomplete: it also has to say that it answered. `status` is
 * already `needs-permission` by the time this runs (main applies
 * `permission-held` off the same `can_use_tool`, one IPC message earlier), and
 * because nothing is queued, `hasApproval` is false. Status `needs-permission`
 * + no held approval + not recently decided IS the terminal-handoff bar's
 * render condition — so an allow-all Direct session grew "Claude is asking
 * permission in the terminal", over an [Open Terminal] button, in a mode that
 * has no terminal, on every single gated call. `suppressHandoff` is the same
 * window the manual path already opens on Allow/Deny (`recentlyDecided`), for
 * the same reason and with the same generosity: the decision leaves here
 * synchronously, the resolution comes back over IPC.
 *
 * It is not a substitute for the main-side fix. `decide` now applies
 * `permission-resolved` (see `main/sessions/stream-permissions.ts`), so the
 * status recovers in a round trip instead of a tool call; this covers the round
 * trip. Both, because either alone still shows the user a bar it should not.
 *
 * PTY sessions do not reach this branch at all: their allow-all is answered at
 * the SERVER (`HookListener.setAllowAll`), so no request is ever pushed to the
 * renderer for one. Nothing here changes #125's PTY behaviour.
 */
export function intakePermission(
  r: IncomingPermission,
  cardId: string,
  ports: PermissionIntake
): void {
  if (r.cardId !== cardId) return;
  if (ports.isAllowAll(r.sessionId)) {
    ports.decide(r.requestId, 'allow');
    ports.suppressHandoff();
    return;
  }
  ports.queue(r);
  ports.surface();
}
