// The two clauses the find bar's toggles turn into a regex — in `shared`
// because BOTH processes have to build the same one (#520).
//
// The transcript engine (`main/transcripts/search.ts`) counts the matches; the
// Session view (`renderer/src/lib/feed-marks.ts`) paints them. A bar reading
// "3" over two marks is a worse answer than no marks at all, so the two must
// agree about what a match IS — and "agree" cannot be a comment in two files
// asking to be kept in step. It is these five lines, imported by both.
//
// What is NOT here is the rest of `compileMatcher`: regex mode, the
// unsafe-shape refusal and the flags are the ENGINE's, because they are about
// what is safe to run over a multi-megabyte file on the main process. The
// renderer never sees a regex term (§5.31 ships case and whole-word only) and
// the marks it paints are a decoration over what the engine already found.

/** Every character a literal term must not smuggle into a pattern. */
export function escapeLiteral(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wrap a pattern body so it only matches OUTSIDE a longer word.
 *
 * Lookarounds, not `\b`: `\b` is defined against what is on BOTH sides, so a
 * term that starts or ends with punctuation (`--force`, `foo()`) gets the
 * opposite of the intended meaning from it. `(?<!\w)…(?!\w)` says the one thing
 * the option promises — the match is not inside a longer word — whatever the
 * term itself begins with.
 */
export function wholeWordBody(body: string): string {
  return `(?<!\\w)(?:${body})(?!\\w)`;
}
