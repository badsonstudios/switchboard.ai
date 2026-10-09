// The colours a group can have.
//
// Persisted DATA, not renderer styling (the renderer's token rule bans raw
// colours in TSX), and legible on every theme. It lived in
// `main/workspace/group-ipc.ts` until #1165, when the workspace store needed it
// too — to move saved groups off the two colours that were retired — and the
// store cannot import the IPC module that imports it.

/**
 * In the order a new group is given one. Appending is safe; reordering changes
 * the colour of every group created from then on.
 *
 * NONE OF THESE IS YELLOWISH (#1165, `shared/reserved-hue.ts`): yellow, gold
 * and orange mean "a session needs you" and nothing else.
 * `theme/reserved-hue.test.ts` fails if one is added.
 */
export const GROUP_PALETTE = [
  '#4a90d9',
  '#8f6fd8',
  '#3aa675',
  '#5b6ee1', // was #d98f3d, an orange
  '#d95f6a',
  '#3fb6c4',
  '#c96fb0',
  '#a35fd0', // was #a3a83e, an olive-yellow
] as const;

/** the two that were retired, and the colour each one's groups become */
export const RETIRED_GROUP_COLORS: Readonly<Record<string, string>> = {
  '#d98f3d': '#5b6ee1',
  '#a3a83e': '#a35fd0',
};
