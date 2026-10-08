// Where the sessions are listed (#1143) — the vocabulary, not the rendering.
//
// Two answers: the rail down the left, which is what the app has always had and
// stays the default, or one strip across the top. It is a closed set in a
// module of its own for the reason `settings-sections` is: the title bar, the
// settings screen and App all have to name these two values, and none of them
// should import the type out of another's component to do it.

export const SESSIONS_PLACEMENTS = ['left', 'top'] as const;

export type SessionsPlacement = (typeof SESSIONS_PLACEMENTS)[number];

export const DEFAULT_SESSIONS_PLACEMENT: SessionsPlacement = 'left';

/** the ui-blob key the choice is stored under, beside `railHidden` */
export const SESSIONS_PLACEMENT_KEY = 'sessionsPlacement';

/**
 * What was stored, as a placement.
 *
 * The ui blob is a file on disk that an older or a newer build may have
 * written, so anything that is not one of the two words reads as the default
 * rather than as a third placement nothing knows how to draw.
 */
export function sessionsPlacementOf(raw: unknown): SessionsPlacement {
  return SESSIONS_PLACEMENTS.includes(raw as SessionsPlacement)
    ? (raw as SessionsPlacement)
    : DEFAULT_SESSIONS_PLACEMENT;
}

/**
 * What one click on the title bar's left / top switch does.
 *
 * ONE RULE, here rather than in the click handler, because the switch carries
 * two facts on two buttons and "hidden" is not a third button (the owner's
 * call, 2026-10-08): the lit half is the placement you are looking at, and
 * clicking the lit half puts the list away. Clicking either half while the list
 * is hidden brings it back, in that placement.
 */
export function placementClick(
  now: { placement: SessionsPlacement; hidden: boolean },
  clicked: SessionsPlacement
): { placement: SessionsPlacement; hidden: boolean } {
  if (now.hidden) return { placement: clicked, hidden: false };
  if (clicked === now.placement) return { placement: clicked, hidden: true };
  return { placement: clicked, hidden: false };
}
