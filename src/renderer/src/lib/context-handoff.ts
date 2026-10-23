// The keyboard and palette routes to §5.5's context hand-off (#851).
//
// The context chip shipped in #799 as a drag handle and nothing else, so the
// one gesture that STARTS a hand-off was the one part of the feature a keyboard
// could not reach. §5.32's fifth rule (#253) is the standard: "a drag is never
// the only way to do something", and the equivalent must call THE SAME state
// change the drop calls — never a parallel path that can drift.
//
// So this module does not hand anything over. It carries two facts across the
// gap between the card that STARTS a hand-off and the card that RECEIVES it,
// and the receiving composer then calls the very `onContextDrop` a real drop
// calls. The offer, the dialog, the inbox and every refusal are the drop's own.
//
//   * `picker` — which card's "Hand this session's context to…" picker is open.
//     Set by the chip (click, Enter, Space) and by the palette command; the
//     picker renders INSIDE that card, so it travels with a popped-out card
//     into its own window, the way the card's other dialogs do.
//   * `pending` — the hand-off just asked for: the TARGET card, and the SOURCE
//     session's live id (what a drop carries on its transfer). The grid reacts
//     by bringing the target's Session view forward; the target's composer
//     takes the request when it mounts, or at once if it is already mounted.
//
// WHY A PENDING REQUEST AND NOT A DIRECT CALL. Only the ACTIVE tab of a
// dockview group is rendered (measured in #798's spec), and a card on its
// Changes tab has no composer at all — so the composer that must answer may not
// exist at the moment the user picks it. A drag never had this problem because
// you can only drop on what you can see. The request waits for the composer
// instead, and EXPIRES, so a target that never comes up (closed in the
// meantime) cannot open a dialog on someone minutes later.
//
// Module-level and not persisted, like `sibling-inbox`'s in-memory half: a
// hand-off in flight is not a fact a relaunch should inherit.
import { useSyncExternalStore } from 'react';

/** how long a request waits for its target's composer before it is dropped */
export const HANDOFF_TTL_MS = 5_000;

export interface HandoffRequest {
  /** the card whose composer receives the offer */
  target: string;
  /** the SOURCE session's live id — exactly what a dropped chip carries */
  fromLiveId: string;
  /** epoch ms the request was made, for the expiry */
  at: number;
}

let picker: string | null = null;
let pending: HandoffRequest | null = null;
/**
 * The latest request, TAKEN OR NOT — what the grid reacts to. Separate from
 * `pending` because listeners run in subscription order: a target composer that
 * is already mounted can take the request before the grid's listener runs, and
 * the grid must still bring that card forward.
 */
let latest: HandoffRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function subscribeHandoff(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Open the target picker on this card (the chip, or the palette command). */
export function openHandoffPicker(cardId: string): void {
  if (picker === cardId) return;
  picker = cardId;
  emit();
}

export function closeHandoffPicker(): void {
  if (picker === null) return;
  picker = null;
  emit();
}

/** which card's picker is open, if any */
export function handoffPickerCard(): string | null {
  return picker;
}

/** true while THIS card's picker is open — the card renders it */
export function useHandoffPickerOpen(cardId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeHandoff,
    () => cardId !== undefined && picker === cardId,
    () => false
  );
}

/**
 * Ask `target`'s composer to offer it the context of the session `fromLiveId`.
 *
 * ONE AT A TIME, latest wins: the picker is modal, so a second request can only
 * come from a second deliberate pick, and that is the one the user means.
 * The composer side refuses a second offer while one is on the wire anyway.
 */
export function requestHandoff(target: string, fromLiveId: string, now: number = Date.now()): void {
  if (!target || !fromLiveId) return;
  picker = null;
  pending = { target, fromLiveId, at: now };
  latest = pending;
  emit();
}

/**
 * The most recent request, whether or not a composer has taken it yet — and
 * CLEARED by reading it. The grid is its one reader, and clearing here rather
 * than remembering "handled" in the grid means a grid that re-mounts cannot
 * replay an old request's view switch on the next unrelated notify.
 */
export function takeLatestHandoff(): HandoffRequest | null {
  const r = latest;
  latest = null;
  return r;
}

/** the request in flight, if it has not expired and has not been taken */
export function pendingHandoff(now: number = Date.now()): HandoffRequest | null {
  if (pending && now - pending.at > HANDOFF_TTL_MS) pending = null;
  return pending;
}

/**
 * Take the request addressed to `cardId`, if there is a live one.
 *
 * TAKING CLEARS IT, so a composer that re-mounts (a view-tab switch, a pop-out)
 * cannot open the same dialog twice. Answers the source's live id.
 */
export function takeHandoff(cardId: string | undefined, now: number = Date.now()): string | null {
  const p = pendingHandoff(now);
  if (!p || !cardId || p.target !== cardId) return null;
  pending = null;
  return p.fromLiveId;
}

/**
 * Card statuses with no prompt box to land on: a suspended or never-started
 * card renders its resume panel instead of a composer, and an ended or crashed
 * one sits under the ended overlay — a drag cannot reach any of them.
 */
const NO_COMPOSER: ReadonlySet<string> = new Set(['suspended', 'not-started', 'ended', 'crashed']);

/**
 * Who the picker offers, in rail order: every other session a drop could land
 * on.
 *
 * §5.32's rule, both ways round: a destination the drop refuses is ABSENT from
 * the menu. So the source is absent (a self-drop is refused out loud), and so
 * is every card without a running session's composer. Offering one would be
 * worse than a missing entry — the pick would bring the card forward and then
 * do nothing, and the request would wait for a composer that a Resume could
 * mount seconds later, opening a dialog nobody asked for at that moment.
 *
 * A card whose status is not known yet is offered (fail-open): it has a live
 * session, and a live card renders its composer.
 */
export function handoffTargets<T extends { id: string; liveId?: string; status?: string }>(
  railOrder: readonly T[],
  fromCardId: string
): T[] {
  return railOrder.filter(
    (s) => s.id !== fromCardId && !!s.liveId && !(s.status !== undefined && NO_COMPOSER.has(s.status))
  );
}

/** test seam: forget everything */
export function resetHandoffForTests(): void {
  picker = null;
  pending = null;
  latest = null;
  listeners.clear();
}
