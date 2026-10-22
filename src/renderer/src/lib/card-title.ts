// The name a session card goes by — on its tab, in its announcer, in the rail
// (#250). It was also the card header's name until #905 left that to the tab,
// and is again since #1405, which also put it in the message box.

/**
 * Pick a card's header name from the three sources, most-current first.
 *
 * `birthTitle` is dockview's `panel.api.title`, which is set once at `addPanel`
 * and never again — nothing in the tree calls `setTitle`, which is the bug this
 * exists for. It is kept only for the frames between a card mounting and the
 * first `setSessions` landing, when the store has no answer yet.
 *
 * EMPTY COUNTS AS ABSENT. A blank title can no longer be MADE — #294 rejects
 * one at the rail's field and again in main's `sessions:renameCard` — but a
 * workspace written before that fix can still hold one, and a header that
 * rendered it would leave the card with no visible identity. The conversation
 * landmark (#196) stops one rung earlier and announces the bare "Conversation"
 * rather than the folder — a path is a poor thing to hear read aloud, which is
 * not a reason to blank the screen.
 *
 * The folder is reduced to its LAST SEGMENT: it arrives here absolute, and a
 * whole path is a poor name on a tab, in a rail row, or read aloud.
 */
export function cardHeaderTitle(
  storeTitle: string | undefined,
  birthTitle: string | undefined,
  folder: string | undefined
): string {
  return storeTitle || birthTitle || basename(folder) || '';
}

function basename(folder: string | undefined): string | undefined {
  return folder?.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

/** How many characters of a session's name the message box's placeholder
 *  shows before it cuts to an ellipsis (#1405). */
export const COMPOSER_NAME_MAX = 40;

/**
 * The session's name as the message box's placeholder says it (#1405):
 * "Message <name>…". Cut with an ellipsis past `max` characters, because the
 * box sizes itself to its content — placeholder included — and a long name
 * would otherwise wrap it to two lines before anyone typed. Counted in code
 * points, so a name is never cut through the middle of an emoji.
 */
export function composerName(name: string, max = COMPOSER_NAME_MAX): string {
  const chars = Array.from(name.trim());
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('');
}
