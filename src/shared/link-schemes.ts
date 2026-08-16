// What a link in rendered markdown may be opened with — ONE list (#527).
//
// §5.30 states the rule: "`http`/`https`/`mailto` links open in the OS browser
// via `shell.openExternal` against a scheme allowlist; every other scheme is
// refused. No in-app navigation to remote content, ever."
//
// IT LIVES IN `shared/` BECAUSE THREE PLACES NEED THE SAME ANSWER, and the
// three had started to become three lists:
//
//   * `main/fs/ipc.ts` — the GUARD. Main is the only side whose refusal is
//     load-bearing; the renderer is not trusted to have filtered anything, and
//     `fs:openExternal` re-checks every string it is handed.
//   * `renderer/lib/document-link.ts` — the viewer's classifier, deciding what
//     a link in a file on disk means before it decorates it.
//   * `renderer/lib/markdown-links.ts` — the feed's click handler.
//
// The renderer's two are NOT guards and must never be read as one. They are
// there so that what a surface OFFERS matches what main will accept: a list
// that drifts wider than main's produces a link that looks live and silently
// does nothing, and one that drifts narrower produces a link the app refuses
// to open although it would have been safe. Both are bugs a user reports as
// "the link is broken", which is how #527 was reported.
//
// An ALLOW-list, and a short one. A deny-list would be the wrong shape: the
// input is a string from a file or a reply we did not write, and the set of
// schemes an OS has a handler for is open-ended and includes several that are
// "run this" in a trench coat.

/** The schemes any surface may hand to the OS browser. */
export const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

/**
 * Is this a link that may be handed to the OS browser?
 *
 * Parsed with `new URL`, not matched as a string: `HTTPS:` and `http:\\host`
 * are both taken by browsers and neither is what a naive `startsWith` sees.
 * Anything that does not parse at all is refused — a string that is not a URL
 * is not a URL we should be opening.
 *
 * Callers that may be handed a bare filesystem path (the document viewer's
 * classifier) must decide "does this even have a scheme" BEFORE calling this:
 * `new URL('C:/x/y.md')` parses as the scheme `c:`.
 */
export function isAllowedLinkUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    return (ALLOWED_LINK_SCHEMES as readonly string[]).includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
