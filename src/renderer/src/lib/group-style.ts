// How groups look in the sessions list (#1556): Settings ▸ Appearance.
//
// Dan, 2026-11-06: "you can't tell the groups from each other easily or tell
// the groups from just plain sessions." Shown eight treatments side by side
// (`mockups/rail-groups.html`), he liked the folder tab best, then asked for
// every one of them behind a setting, with today's look kept as "Classic".
//
// THE NUMBERS ARE THE MOCKUP'S: option 4 in the ticket is `folder` here, and
// the settings list shows "4 · Folder tab". Classic is unnumbered (it is the
// mockup's "0 · today").
//
// ONLY THE SESSIONS LIST follows this. The strip across the top and the grid's
// group frames keep their own look (Dan, 2026-11-07).
//
// The drawing is CSS (`theme/tokens.css`, "group styles"), keyed on a
// `data-group-style` attribute the rail puts on its own <nav>. Classic is the
// exception: its look is the rail's inline styles, applied only while Classic
// is on, so the look everybody had until now cannot drift.
//
// The choice is purely how the window draws, so it lives here in a renderer
// store (stored in the ui blob) rather than going through App.
import * as React from 'react';
import { uiGet, uiSet } from './ui-state';

/** Every style, in the mockup's order: index = the number it is shown with. */
export const GROUP_STYLES = [
  'classic',
  'frame',
  'spine',
  'solid',
  'folder',
  'tree',
  'wells',
  'outlines',
  'heading',
] as const;

export type GroupStyle = (typeof GROUP_STYLES)[number];

/**
 * The styles that are BUILT. The rest land in later parts of #1556; until then
 * Settings does not offer them, because a choice that changes nothing is a
 * broken setting.
 */
export const AVAILABLE_GROUP_STYLES: readonly GroupStyle[] = ['classic', 'folder'];

/** option 4, Dan's pick */
export const DEFAULT_GROUP_STYLE: GroupStyle = 'folder';

/** the ui-blob key */
export const GROUP_STYLE_KEY = 'groupStyle';

/** A stored value, or the default for anything that is not a built style: a
 *  blob from a newer build must not leave the list with no look at all. */
export function groupStyleOf(raw: unknown): GroupStyle {
  return AVAILABLE_GROUP_STYLES.includes(raw as GroupStyle) ? (raw as GroupStyle) : DEFAULT_GROUP_STYLE;
}

/** The number a style is shown with; Classic has none. */
export function groupStyleNumber(style: GroupStyle): number | undefined {
  const i = GROUP_STYLES.indexOf(style);
  return i > 0 ? i : undefined;
}

let current: GroupStyle = DEFAULT_GROUP_STYLE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Read the stored style, once the ui blob has loaded (App calls this). */
export function initGroupStyle(): void {
  current = groupStyleOf(uiGet<unknown>(GROUP_STYLE_KEY, undefined));
  emit();
}

/** Settings ▸ Appearance: the list changes at once, no restart. */
export function setGroupStyle(next: GroupStyle): void {
  current = groupStyleOf(next);
  uiSet(GROUP_STYLE_KEY, current);
  emit();
}

/** React binding. */
export function useGroupStyle(): GroupStyle {
  return React.useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_GROUP_STYLE
  );
}

/** Tests only. */
export function resetGroupStyleForTests(style: GroupStyle = DEFAULT_GROUP_STYLE): void {
  current = style;
  emit();
}
