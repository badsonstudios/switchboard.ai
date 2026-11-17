// Group colours on or off in the sessions list (#1599): Settings ▸ Appearance.
//
// Dan, 2026-11-09: "You can turn off the colors for groups. Not any color, but
// the color for groups. I like mine on, but somebody may not."
//
// OFF draws every group you made in the theme's neutral grey (`--group-frame`) where
// its own colour went: the dot, the header tint, and the frame, spine, tab,
// guide line or underline of whichever group style is on. The "working" look
// that borrows the group colour falls back to the normal working colour.
// Nothing else changes: status colours, the waiting and approval cues, the
// automatic folder groups' look, focus, selection and the drop lines.
//
// The colour picked for each group is NOT touched: this is how the window
// draws, so it lives here in a renderer store (the ui blob, as the group style
// does) and never writes a group. Turning it back on shows every colour as it
// was. Like the group style, only the sessions list follows it.
import * as React from 'react';
import { uiGet, uiSet } from './ui-state';

/** the ui-blob key */
export const GROUP_COLOURS_KEY = 'groupColours';

/** what a group you made is drawn in while colours are off */
export const NEUTRAL_GROUP_COLOUR = 'var(--group-frame)';

/** Stored values other than `false` read as ON: the default, and a blob from
 *  another build must not quietly take colour away. */
export function groupColoursOf(raw: unknown): boolean {
  return raw !== false;
}

/**
 * The colour a group card is drawn in: its own while colours are on, the
 * neutral ink while they are off. Only a group you MADE has a colour that is
 * data; an automatic group and "No group" keep their theme tokens either way.
 */
export function drawnGroupColour(kind: 'group' | 'auto' | 'ungrouped', color: string, coloursOn: boolean): string {
  return kind === 'group' && !coloursOn ? NEUTRAL_GROUP_COLOUR : color;
}

let current = true;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Read the stored choice, once the ui blob has loaded (App calls this). */
export function initGroupColours(): void {
  current = groupColoursOf(uiGet<unknown>(GROUP_COLOURS_KEY, undefined));
  emit();
}

/** Settings ▸ Appearance: the list changes at once, no restart. */
export function setGroupColours(on: boolean): void {
  current = on;
  uiSet(GROUP_COLOURS_KEY, on);
  emit();
}

/** React binding. */
export function useGroupColours(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => current,
    () => true
  );
}

/** Tests only. */
export function resetGroupColoursForTests(on = true): void {
  current = on;
  emit();
}
