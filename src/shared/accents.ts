// The §5.11 session accent palette — the eight distinguishable colours, and the
// one place TypeScript writes their values down.
//
// `renderer/src/theme/tokens.css` declares the same eight as `--accent-*`, and it
// has to: CSS cannot read this file. That pair is compared rather than trusted —
// `tokens.drift.test.ts` fails if either side is retuned alone, because a session
// is painted with the value that was PERSISTED, so a changed token would repaint
// new sessions only and nothing on screen would say why.
//
// MOVED HERE FROM `main/sessions/identity.ts` (#946), and moved rather than
// re-exported: that file no longer publishes it, so there is ONE import path for
// the palette and its one other reader (`identity.test.ts`) was repointed here.
// A re-export would have spared that one edit at the price of two names for one
// constant, which is the shape `shared/sessions.ts` spends a header warning about.
//
// The move is not tidying: the dispatch role templates (§5.15) give each built-in
// its own identity colour, they live in `shared/` because the renderer paints
// them, and `shared/` cannot import `main/` (eslint enforces it, §5.23). The
// alternative was a second copy of these hex values in a second TypeScript file —
// which is exactly the drift this codebase has paid for twice, most recently in
// #590's two declarations of one wire shape. A palette with two homes is a palette
// that can disagree with itself.
//
// `assignAccent` deliberately did NOT come along. Choosing the least-used colour
// is a question about the sessions that are running right now, and main is the
// only side that knows that; it stays where it was.
//
// WHY THE NAMES ARE HERE TOO AND NOT JUST THE VALUES: the names match the token
// names in `renderer/src/theme/tokens.css`, so a caller can say *which* accent it
// means without repeating a hex literal — which the renderer's own lint rule
// forbids outright (`eslint.config.mjs`, §5.20). `accentByName` is how a
// shared-side default gets a real colour without writing one down twice.

/**
 * §5.11's distinguishable accents, in assignment order. Token names match
 * `renderer/src/theme/tokens.css`.
 *
 * The ORDER is `assignAccent`'s preference order — a first session gets amber —
 * so appending here is safe and reordering is a visible change to every fresh
 * workspace.
 */
export const ACCENTS = [
  { name: 'amber', value: '#e3b341' },
  { name: 'teal', value: '#39c5bb' },
  { name: 'violet', value: '#a78bfa' },
  { name: 'green', value: '#3fb950' },
  { name: 'blue', value: '#58a6ff' },
  { name: 'coral', value: '#f0776b' },
  { name: 'pink', value: '#db61a2' },
  { name: 'orange', value: '#f0883e' },
] as const;

/** One of the eight names above. Derived from the values, not hand-written. */
export type AccentName = (typeof ACCENTS)[number]['name'];

/**
 * The hex for a named accent.
 *
 * Total by construction — `AccentName` is derived from `ACCENTS`, so there is no
 * name this can be handed that is not in the table, and no `undefined` branch to
 * default. That is the whole reason to take a name rather than a string.
 */
export function accentByName(name: AccentName): string {
  // The non-null assertion is load-bearing on the type above, not on a hope:
  // `AccentName` cannot name a row that is absent.
  return ACCENTS.find((a) => a.name === name)!.value;
}
