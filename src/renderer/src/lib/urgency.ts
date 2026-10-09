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
//                      strip's lamps and the rail's rows can never disagree
//                      about what a session IS;
//   lit              — "this is the one you were just sent to", true for a beat
//                      after the jump and independent of what the status did in
//                      the meantime.
//
// Pure by construction (no React, no DOM, no clock of its own — `now` is always
// passed in) so every rule below is a unit test rather than an e2e guess.

/**
 * How long the arrived-at lamp stays lit after a jump.
 *
 * §5.8 says "a configurable beat (~0.5–2s)"; the work item pins the default at
 * ~1.5s. It is not a setting yet — DESIGN's "configurable" belongs with E9-10's
 * focus-stealing policy, where the rest of the attention knobs land.
 */
export const URGENCY_LINGER_MS = 1500;

// The strip's "N need you" aggregate used to live here as `litCount(lamps)` —
// a second copy of `rail-view`'s `needCount`, counting the same `needsYou`
// flag. #621 unified them: the strip now calls `needCount` directly, over
// `lib/queue`'s needing-cards set, so the aggregate and the rail's own two
// counters are one derivation and dismissal moves all three at once. The lamps
// keep `needsYou` — that is the lamp's HUE, not the count.

/**
 * The lit map: card id -> the epoch ms at which that lamp's beat ends, or
 * **`null` for a lamp that has been marked but not yet PAINTED**.
 *
 * The `null` rung is the whole of #320 *(Dan, 2026-08-10 — the beat runs from
 * first paint)*. A jump used to stamp `keypress + 1500` and every render
 * compared that against a fresh clock, so on a machine busy enough that the
 * strip did not paint within the beat, the lamp was never drawn lit AT ALL —
 * not drawn late, never drawn. §5.8 wants the beat so a HUMAN can see which
 * session called them, and it failed silently in exactly the busy moments the
 * signal matters most.
 *
 * So a mark is now two-phase: `markLit` writes `null` ("lit, beat not started")
 * and `startBeat` — called from the strip once the lit lamp is on the screen —
 * converts it to a real deadline. A `null` entry is unconditionally lit and
 * arms no timer: nothing is counting down yet.
 *
 * At most ONE entry is `null` at a time — `markLit` drops the older ones, see
 * there (issue 426). The rules below still handle several because a rule that
 * assumes an invariant it does not enforce is a rule that breaks silently when
 * the invariant moves.
 */
export type UrgencyMarks = ReadonlyMap<string, number | null>;

/**
 * Is this card still highlighted?
 *
 * A `null` entry — marked, not yet painted — is lit unconditionally: its beat
 * has not started, so there is no deadline to be past. That is the property
 * that makes a slow machine show the lamp instead of skipping it.
 *
 * Otherwise strictly `>`: an entry whose deadline is exactly `now` has run out.
 * That makes the boundary the same for the render and for the timer that
 * schedules the re-render, so a lamp can never be painted lit with a timer that
 * has already fired.
 */
export function isLit(lit: UrgencyMarks, cardId: string, now: number): boolean {
  const until = lit.get(cardId);
  // `undefined` is "no entry" — the map never stores undefined, so this cannot
  // be confused with the `null` (unpainted) rung
  if (until === undefined) return false;
  return until === null || until > now;
}

/**
 * Mark a lamp as lit — WITHOUT starting its beat — expiring anything already
 * run out in the same pass. `startBeat` gives it a deadline once it paints.
 *
 * Pruning here as well as in `pruneLit` is deliberate: jumps are the only thing
 * that grows this map, so folding the sweep into the write means the map cannot
 * outgrow the session list even if a render (and therefore the expiry timer)
 * never happens — a backgrounded window, say.
 *
 * **AT MOST ONE MARK IS EVER WAITING ON A PAINT — the latest** *(Dan,
 * 2026-08-11, issue 426)*. A lamp whose beat is RUNNING is never touched here:
 * jump A, jump B a moment later and both rings are on the screen together, the
 * overlap §5.8 has always had. But a mark that has never painted carries no
 * information a newer one does not, and a queue of them is a fireworks show:
 * `Ctrl+Space` routes through the main renderer while focus raises a POPOUT, so
 * an operator working across popouts can leave the main window occluded and
 * unpainted for several jumps — and every queued ring would then fire at once
 * on return, all of them stale, none of them the answer to "where did I just
 * land?". Dropping the older ones costs nothing seen: nobody has seen them.
 */
export function markLit(lit: UrgencyMarks, cardId: string, now: number): Map<string, number | null> {
  const next = new Map<string, number | null>();
  // `until !== null` is the cap: unpainted marks do not survive a newer mark,
  // where a running beat does until its deadline passes
  for (const [id, until] of lit) if (until !== null && until > now) next.set(id, until);
  next.set(cardId, null);
  return next;
}

/**
 * The strip has painted: start the beat for every mark that was still waiting
 * on one. Returns null when none was — the same no-op discipline as `pruneLit`,
 * so the frame after every ordinary paint costs no state write.
 *
 * Only `null` entries are touched. A card whose beat is already running is left
 * alone: re-stamping it on every repaint would make the lamp stay lit for as
 * long as the strip kept re-rendering, which is a beat with no end.
 */
export function startBeat(
  lit: UrgencyMarks,
  cardIds: Iterable<string>,
  now: number
): Map<string, number | null> | null {
  let next: Map<string, number | null> | null = null;
  for (const id of cardIds) {
    // reads whichever map is current, so a repeated id in `cardIds` is skipped
    // the second time rather than relying on `now` being fixed within the call
    if ((next ?? lit).get(id) !== null) continue; // no entry, or already counting down
    next ??= new Map(lit);
    next.set(id, now + URGENCY_LINGER_MS);
  }
  return next;
}

/**
 * Drop lamps whose beat has passed. Returns null when there was nothing to
 * drop, so the caller can skip a state write and the re-render it would cost —
 * the same no-op discipline lib/presentation uses.
 *
 * An unpainted mark is never expired here: it is waiting for a paint, not for
 * a clock.
 */
export function pruneLit(lit: UrgencyMarks, now: number): Map<string, number | null> | null {
  const expired = [...lit.entries()].filter(([, until]) => until !== null && until <= now);
  if (expired.length === 0) return null;
  const next = new Map(lit);
  for (const [id] of expired) next.delete(id);
  return next;
}

/**
 * Milliseconds until the next lamp goes out, or null when none is COUNTING
 * DOWN — what the strip arms a single timer with, rather than polling a clock.
 *
 * Unpainted marks are skipped: they have no deadline yet, and the paint that
 * gives them one re-runs the effect that arms this timer. A strip whose only
 * lit lamps are unpainted therefore asks the OS for nothing at all.
 *
 * Never negative: an already-passed deadline schedules immediately.
 */
export function nextLitExpiry(lit: UrgencyMarks, now: number): number | null {
  let soonest: number | null = null;
  for (const until of lit.values()) {
    if (until === null) continue;
    if (soonest === null || until < soonest) soonest = until;
  }
  return soonest === null ? null : Math.max(0, soonest - now);
}
