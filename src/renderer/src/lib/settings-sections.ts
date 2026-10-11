// The settings screen's sections (#885) — the vocabulary, not the rendering.
//
// A three-word list does not need a module of its own, but the alternative was
// `command-set.ts` importing a type out of a component to name the section its
// aliases jump to. The rest of this folder already holds the closed vocabularies
// the commands speak in (`layout-mode`, `presentation-policy`, `focus-policy`);
// this is one more, and it keeps the arrow pointing the way the others do —
// components import from lib, never the reverse.

/**
 * The TABS of the settings window, in the order they are drawn (#1199).
 *
 * The owner: "We need to organize the settings a little more, possibly with
 * some tabs." The window had grown to fourteen settings in one scroll under
 * four headings. Each id here is one tab AND one section: a deep link names a
 * section, and opening at a section means opening on its tab.
 *
 * `appearance` IS FIRST, and it is where the window opens the first time. It
 * holds what people come here to change (the theme, where the list of sessions
 * goes, how a busy session looks); `general` is the things you set once.
 *
 * `attention` keeps its id although its tab is labelled "Notifications": the
 * id is what the palette's deep links name, and renaming it would be a change
 * to every one of them for the sake of a word nobody sees.
 *
 * `diagnostics` and `advanced` are LAST on purpose (#923): the two nobody
 * should need. An off-by-default instrument beside the theme picker would
 * advertise it as ordinary.
 */
export const SETTINGS_SECTIONS = [
  'appearance',
  'general',
  'attention',
  'sessions',
  'diagnostics',
  'advanced',
] as const;

/** where the window opens when nothing has said otherwise */
export const DEFAULT_SETTINGS_SECTION: (typeof SETTINGS_SECTIONS)[number] = 'appearance';

/**
 * The tab an arrow key moves to from `from`: wrapping, so the list has no
 * dead end. Pure, so the keyboard contract is a unit test.
 */
export function stepSettingsSection(
  from: (typeof SETTINGS_SECTIONS)[number],
  key: string,
  rtl = false
): (typeof SETTINGS_SECTIONS)[number] | null {
  const n = SETTINGS_SECTIONS.length;
  const i = SETTINGS_SECTIONS.indexOf(from);
  const next = rtl ? 'ArrowLeft' : 'ArrowRight';
  const prev = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === next) return SETTINGS_SECTIONS[(i + 1) % n];
  if (key === prev) return SETTINGS_SECTIONS[(i - 1 + n) % n];
  if (key === 'Home') return SETTINGS_SECTIONS[0];
  if (key === 'End') return SETTINGS_SECTIONS[n - 1];
  return null;
}

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

// NO `isSettingsSection` GUARD, deliberately. The first draft had one, with a
// §5.29 comment on it, and nothing called it: a section name never crosses a
// process boundary — `openSettings` is a renderer-internal callback and the
// type already constrains every caller. An exported guard with a
// load-bearing-sounding comment and no call sites is worse than none, because
// the next reader assumes a boundary is checked. Add it when something
// untrusted actually names a section.
