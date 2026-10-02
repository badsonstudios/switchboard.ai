// One definition of "is this path safe to hand git?" (E24 Git v2).
//
// ⚠️ **EXTRACTED FROM `git-log.ts` WHEN LAYER 2 ARRIVED, AND THE REASON IS THE
// ASYMMETRY BETWEEN THE TWO HALVES.** The read half's own comment says a refused
// path there is answered with the *unfiltered* history — "a wider answer and
// never a wrong one". For a WRITE that bargain inverts completely: a wider answer
// means staging, or **discarding**, files the user did not name. So the rule had
// to be shared rather than re-stated, because a second copy of it is a second
// thing that can be relaxed by somebody who only reads the read half's comment.
//
// WHAT GETS THROUGH A `--`, MEASURED, and the reason this function exists at all:
//
//  - **`..` escapes the session folder**, because git resolves a pathspec against
//    the cwd rather than the repository root. In `<repo>/sub`, `-- ../secret.txt`
//    reaches a file the session was never scoped to.
//  - **an absolute path** reaches anywhere in the repository for the same reason,
//    and on Windows it can be spelled `C:/…` as well as `/…`.
//  - **a leading `:` is pathspec MAGIC** — `:(exclude)src/**`, `:!src` — read as
//    magic even after the `--`. On a write that is not a wrong answer, it is a
//    different *operation*: `:(exclude)` on a discard inverts which files are
//    thrown away.
//
// (Wildcards are handled elsewhere and globally: `--literal-pathspecs` rides in
// `guardArgs()` on every invocation, because a filename is not a pattern. That
// finding is recorded there.)

/**
 * git speaks forward slashes everywhere, including on Windows.
 *
 * ⚠️ **AND THIS IS A KNOWN, NARROW LOSS ON macOS AND LINUX**, stated rather than
 * hidden: a backslash is a legal character IN a filename there, so a file really
 * called `a\b.txt` is folded to `a/b.txt` and names a different path. It is
 * refused rather than silently rewritten only because the fold happens first —
 * see `safeGitPath`, which reports what it would actually pass so a caller can
 * tell the user instead of acting on the wrong file.
 */
export function toGitPath(raw: string): string {
  return raw.split('\\').join('/').replace(/^\.\//, '');
}

/**
 * The path git will be given, or `undefined` if we will not pass it.
 *
 * `undefined` rather than a throw: both halves have something sensible to do with
 * a refusal, and they are different things — the read half widens and SAYS it
 * widened (`GitLog.pathRefused`), the write half refuses the whole operation.
 */
export function safeGitPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const p = toGitPath(raw);
  if (p === '' || p.startsWith(':')) return undefined;
  // Absolute in either spelling: POSIX root, a UNC share, or a drive letter.
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return undefined;
  if (p.split('/').includes('..')) return undefined;
  return p;
}

/**
 * Every path, or `undefined` if ANY of them is refused.
 *
 * ⚠️ **ALL OR NOTHING, AND FOR A WRITE THAT IS THE ONLY DEFENSIBLE CHOICE.**
 * Filtering the bad ones out would mean a "stage these six files" that staged
 * five, or — far worse — a "discard these six" that discarded five and reported
 * success. A partial destructive operation the user was not told about is the
 * worst outcome available here, so one bad entry refuses the batch and the caller
 * says so.
 */
export function safeGitPaths(raw: readonly string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: string[] = [];
  for (const one of raw) {
    const safe = safeGitPath(one);
    if (safe === undefined) return undefined;
    out.push(safe);
  }
  return out;
}
