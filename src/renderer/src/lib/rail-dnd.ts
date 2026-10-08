// What is in flight when something in a list of sessions is dragged.
//
// These were private to `SessionsRail` until the sessions strip (#1143) became a
// second list you can drag in. They are the SAME two types in both on purpose:
// a session dragged from one is a session wherever it is dropped, and nothing
// has to translate.

/** A SESSION being dragged: the payload is its card id. */
export const DND_TYPE = 'application/x-switchboard-card';

/**
 * A GROUP being dragged by its header (#1144).
 *
 * ITS OWN TYPE, and that is the whole of how a group drag and a session drag
 * stay out of each other's way: every session-drop handler tests for `DND_TYPE`
 * (or a dockview tab in flight) before it does anything, so a group passing
 * over a row, a card or a list's background is simply not a thing those
 * handlers see. A group can never be read as "a session dropped into the group
 * next door" (#582's worry), because it never carries a card.
 */
export const GROUP_DND_TYPE = 'application/x-switchboard-group';
