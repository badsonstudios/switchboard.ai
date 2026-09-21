// The settings screen's sections (#885) — the vocabulary, not the rendering.
//
// A three-word list does not need a module of its own, but the alternative was
// `command-set.ts` importing a type out of a component to name the section its
// aliases jump to. The rest of this folder already holds the closed vocabularies
// the commands speak in (`layout-mode`, `presentation-policy`, `focus-policy`);
// this is one more, and it keeps the arrow pointing the way the others do —
// components import from lib, never the reverse.

/** In render order, which is also the order they appear in the modal. */
export const SETTINGS_SECTIONS = ['appearance', 'attention', 'advanced'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

// NO `isSettingsSection` GUARD, deliberately. The first draft had one, with a
// §5.29 comment on it, and nothing called it: a section name never crosses a
// process boundary — `openSettings` is a renderer-internal callback and the
// type already constrains every caller. An exported guard with a
// load-bearing-sounding comment and no call sites is worse than none, because
// the next reader assumes a boundary is checked. Add it when something
// untrusted actually names a section.
