// The urgency strip and its delayed urgency reset (P2-E9-04, DESIGN §5.8).
//
// §5.8 asks for two things that look like one:
//
//   • "Urgency strip (i3 urgency-hint pattern): a persistent global strip
//     showing every session's urgency state at a glance, visible regardless of
//     layout mode."
//   • "Delayed urgency reset (i3 `force_display_urgency_hint`): after jumping
//     to a session that demanded attention, its urgency lamp stays lit for a
//     configurable beat (~0.5–2s) — you can still see WHICH session called you
//     after you arrive."
//
// They are separate signals and this module keeps them separate:
//
//   token / needsYou — the LIVE status, straight from lib/rail-view so the
//                      strip, the rail rows and the group counts can never
//                      disagree about what "needs you" means;
//   lit              — "this is the one you were just sent to", true for a beat
//                      after the jump and independent of what the status did in
//                      the meantime.
//
// Pure by construction (no React, no DOM, no clock of its own — `now` is always
// passed in) so every rule below is a unit test rather than an e2e guess.
import { presentStatus, StatusToken } from './rail-view';

/**
 * How long the arrived-at lamp stays lit after a jump.
 *
 * §5.8 says "a configurable beat (~0.5–2s)"; the work item pins the default at
 * ~1.5s. It is not a setting yet — DESIGN's "configurable" belongs with E9-10's
 * focus-stealing policy, where the rest of the attention knobs land.
 */
export const URGENCY_LINGER_MS = 1500;

/** One lamp: a session reduced to what the strip paints. */
export interface UrgencyLamp {
  /** the durable card id — what a click focuses, and what survives a resume */
  cardId: string;
  title: string;
  /** the six-way status ramp; var(--status-<token>) is the hue */
  token: StatusToken;
  /** a human is the only thing that can move this session on */
  needsYou: boolean;
  /** the delayed urgency reset — the session the last jump landed on */
  lit: boolean;
  /** restored-but-not-resumed: it folds to the idle hue, but it is not idle,
   *  and the tooltip has to say which one it is */
  suspended: boolean;
  /** i18n key for the state text (the ASK when it needs you, else the state) */
  labelKey: string;
}

/** The shape the strip needs from a session — a structural subset of
 *  RailSession, so the strip is testable without the rail's whole model. */
export interface LampSource {
  id: string;
  title: string;
  status?: string;
}

/**
 * Sessions (in the order they should be painted) -> lamps.
 *
 * ORDER IS THE CALLER'S. The strip renders from the store's rail order, which
 * is also Ctrl+1..9's numbering authority — so the Nth lamp is the Nth hotkey,
 * for free and forever. That is also how "pinned first" (the item's wording,
 * E9-09's contract) arrives: §5.8 makes a pinned session sort first IN THE
 * RAIL, so once E9-09 lands, rail order already leads with the pinned sessions
 * and this function inherits it without a line of change here. Sorting pins
 * locally instead would have been a second ordering authority — the exact thing
 * lib/queue and lib/groups exist to avoid.
 */
export function buildLamps(
  sessions: readonly LampSource[],
  lit: ReadonlyMap<string, number>,
  now: number
): UrgencyLamp[] {
  return sessions.map((s) => {
    const p = presentStatus(s.status);
    return {
      cardId: s.id,
      title: s.title,
      token: p.token,
      needsYou: p.needsYou,
      lit: isLit(lit, s.id, now),
      suspended: s.status === 'suspended',
      labelKey: p.labelKey,
    };
  });
}

/** How many lamps are asking for a human — the strip's own summary, from the
 *  same rule the rail counts with. */
export function litCount(lamps: readonly UrgencyLamp[]): number {
  return lamps.filter((l) => l.needsYou).length;
}

/**
 * Is this card's lamp still lit?
 *
 * Strictly `>`: an entry whose deadline is exactly `now` has run out. That
 * makes the boundary the same for the render and for the timer that schedules
 * the re-render, so a lamp can never be painted lit with a timer that has
 * already fired.
 */
export function isLit(lit: ReadonlyMap<string, number>, cardId: string, now: number): boolean {
  const until = lit.get(cardId);
  return until !== undefined && until > now;
}

/**
 * Light a lamp, expiring anything already run out in the same pass.
 *
 * Pruning here as well as in `pruneLit` is deliberate: jumps are the only thing
 * that grows this map, so folding the sweep into the write means the map cannot
 * outgrow the session list even if a render (and therefore the expiry timer)
 * never happens — a backgrounded window, say.
 */
export function markLit(
  lit: ReadonlyMap<string, number>,
  cardId: string,
  now: number,
  ms: number = URGENCY_LINGER_MS
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [id, until] of lit) if (until > now) next.set(id, until);
  next.set(cardId, now + ms);
  return next;
}

/**
 * Drop lamps whose beat has passed. Returns null when there was nothing to
 * drop, so the caller can skip a state write and the re-render it would cost —
 * the same no-op discipline lib/presentation uses.
 */
export function pruneLit(
  lit: ReadonlyMap<string, number>,
  now: number
): Map<string, number> | null {
  const expired = [...lit.entries()].filter(([, until]) => until <= now);
  if (expired.length === 0) return null;
  const next = new Map(lit);
  for (const [id] of expired) next.delete(id);
  return next;
}

/**
 * Milliseconds until the next lamp goes out, or null when none is lit — what
 * the strip arms a single timer with, rather than polling a clock.
 *
 * Never negative: an already-passed deadline schedules immediately.
 */
export function nextLitExpiry(lit: ReadonlyMap<string, number>, now: number): number | null {
  let soonest: number | null = null;
  for (const until of lit.values()) {
    if (soonest === null || until < soonest) soonest = until;
  }
  return soonest === null ? null : Math.max(0, soonest - now);
}
