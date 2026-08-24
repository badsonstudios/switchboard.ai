// The per-launch id namespace (#673, finishing #654).
//
// Every `React.useId()` consumer in the renderer — the dialogs' fields, the
// palette, and the tab buttons in `SessionGrid` / `QuestionPanel` that sit
// outside every scrim — derives its DOM id from React's module-global counter.
// #654 removed the STABLE, PUBLISHED names, but the counter starts at zero in
// every build, so without a prefix the whole id space is a few hundred
// guessable strings and rendered content could still plant one (`markdown.tsx`
// records the capture rules: an IDREF resolves to the FIRST element in tree
// order). `identifierPrefix` on `createRoot` is the one line that closes the
// class app-wide: with a per-launch random prefix, no string typed into a
// document or a reply before launch can name a live control id.
//
// Crypto-random rather than `Math.random()` because unguessability is the whole
// point of the exercise, and `crypto.getRandomValues` is free in the renderer.
// The charset is [0-9a-f] plus a trailing `_` so the composed id
// (`_<prefix>r_<n>_`) stays a valid HTML id, a valid IDREF target, and needs no
// escaping in a CSS selector.
//
// Called ONCE, in `main.tsx`, per `createRoot` — which is per launch, because
// the renderer has exactly one root (popout windows adopt DOM; they do not
// mount a second React tree). Anything that calls it twice gets two disjoint
// namespaces, which is the test's proof of randomness, not a supported use.
export function rootIdentifierPrefix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `sb${hex}_`;
}
