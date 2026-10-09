// How a WORKING session looks in the Sessions list and on the strip (#718).
//
// The ask, 2026-08-26: the small spinning ring is not enough to answer "which
// of my sessions are busy right now" at a glance. Shown six treatments moving
// side by side (2026-10-09), the owner said: "I like all of these options. I
// think we default to option 3, but in the settings, you can set one of the
// six options that you want."
//
// So it is a setting with six choices, and this file is the list. The drawing
// is all CSS (`theme/tokens.css`, "a working session"), keyed on a
// `data-working-look` attribute that App puts on the document: a row or a pill
// only has to say that it is working and what its session's colour is.
//
// THE NUMBERS ARE THE OWNER'S: the order here is the order he saw them in, so
// "option 3" in the ticket is the third entry.

export const WORKING_LOOKS = ['glow', 'marquee', 'fill', 'shimmer', 'strip', 'bars'] as const;

export type WorkingLook = (typeof WORKING_LOOKS)[number];

/** option 3: the row filled with the session's colour, a bigger spinner, and
 *  the word. No moving frame. */
export const DEFAULT_WORKING_LOOK: WorkingLook = 'fill';

/** the ui-blob key */
export const WORKING_LOOK_KEY = 'workingLook';

/** A stored value, or the default for anything that is not one of the six: a
 *  blob from a build that had a look this one does not must not leave a working
 *  session with no treatment at all. */
export function workingLookOf(raw: unknown): WorkingLook {
  return WORKING_LOOKS.includes(raw as WorkingLook) ? (raw as WorkingLook) : DEFAULT_WORKING_LOOK;
}
