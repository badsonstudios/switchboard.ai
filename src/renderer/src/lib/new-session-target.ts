// Which WINDOW a new session's card belongs in (#531).
//
// ── THE RULE THIS ADDS, AND THE ONE IT MUST NOT BREAK ───────────────────────
//
// #434 and #462 established the opposite rule, and it is still right: dockview's
// `addPanel` defaults to the ACTIVE group, and the active group becomes a
// popout the moment a card is torn off — so a panel opened from the MAIN
// window's chrome (the rail's context menu, the `+ session` button, the
// palette) used to land as a tab inside whatever popped-out session happened to
// have been touched last, where the user never asked for it and could not find
// it. `sessionCardHome` in SessionGrid is that fix and this module does not
// touch it.
//
// #531 is the deliberate version of the same placement: the user is IN a
// popped-out window and asks, from that window, for another session. Then the
// popout is not an accident of dockview's activation state — it is the window
// the request came from, and putting the card anywhere else is the surprise.
//
// The two rules only look alike. The difference is entirely about WHERE THE
// GESTURE HAPPENED, which is why this module answers from focus and never from
// `api.activeGroup`: a group can be active while its window is behind three
// others. Ask the OS which window the user is looking at, or land in the grid.
//
// The ＋ button on a popped-out card's header does not come through here at
// all — it names its own group directly, which is a stronger answer than any
// inference. This exists for the KEYBOARD route (Mod+N, dispatched into
// popouts by App's key bridge), where the command has no card in hand and the
// focused window is the only thing that says what "here" means.

/** The little dockview needs to be asked. Structural, so the unit tests do not
 *  have to build a `DockviewGroupPanel`. */
export interface DockGroupLike {
  readonly id: string;
  /** is this group out in its own OS window? */
  readonly isPopout: boolean;
  /** ...and does that window have focus RIGHT NOW? Always false for a grid
   *  group: the main window is the fallback, never a match. */
  readonly focused: boolean;
}

/**
 * The popped-out group a new session should join, or `null` for "the main
 * window" — which is `sessionCardHome`'s question, not this one's.
 *
 * Exactly one group can pass: a window either has OS focus or it does not.
 * `find` rather than a uniqueness assertion because focus is sampled, not
 * transactional — if two windows ever answered yes in the same tick, the first
 * is as good an answer as any and far better than throwing at a user who
 * pressed Mod+N.
 */
export function newSessionHostGroup<T extends DockGroupLike>(
  groups: readonly T[]
): T | null {
  return groups.find((g) => g.isPopout && g.focused) ?? null;
}
