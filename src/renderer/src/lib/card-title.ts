// The name a session card shows in its own header (#250).

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
 * The folder is reduced to its LAST SEGMENT: it arrives here absolute, and the
 * header's name span is `nowrap` with nothing else in the row able to give way.
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
