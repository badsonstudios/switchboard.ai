// Staging part of a file (E24 Git v2 item 14, §5.7) — screen 8.
//
// ⚠️ **THE WHOLE OPERATION IS "SYNTHESISE A SMALLER PATCH AND APPLY IT TO THE
// INDEX ONLY", and every part of that was measured before it was written.**
//
//  1. **`git apply --cached -` stages exactly what the patch contains** and
//     leaves the WORKTREE untouched. Measured: a one-hunk patch over a two-hunk
//     diff left the file reading `ONE … TEN` on disk while `git status` went to
//     `MM` — a staged change plus the remaining unstaged one, which is precisely
//     what partial staging means.
//  2. ⚠️ **A PATCH THAT CANNOT APPLY LEAVES THE INDEX BYTE-IDENTICAL**, and that
//     is git's own guarantee rather than something built here. Measured: a
//     deliberately wrong hunk gave *"error: patch does not apply"*, exit 1, and
//     `git diff --cached` before and after were identical files. The design
//     record asks that *"a refusal leaves the index untouched and quotes git"* —
//     the first half is free, so what is left to do is the quoting.
//  3. **`apply --cached -R` reverse-applies**, which is how a hunk is UNSTAGED.
//  4. **No `index ..` line is needed** in a synthesised patch; the `diff --git`
//     and `---`/`+++` lines are enough.
//
// ⚠️ **WHAT THIS ITEM SHIPS, AND WHAT IT DOES NOT.** Whole-hunk staging and
// unstaging, both measured against real git. **Line-level selection is NOT
// here** — it was built, it applied cleanly, and it put the WRONG CONTENT in the
// user's index. The counter-example, and the different mechanism selection
// actually needs, are recorded in full further down this file. That is a
// deliberate scope reduction: a partial-staging feature that silently stages the
// wrong lines is worse than one that only does whole hunks.
import { safeGitPath } from './git-paths';

/** One hunk of a unified diff, exactly as git wrote it. */
export interface Hunk {
  /** the `@@ -a,b +c,d @@ …` line, verbatim */
  readonly header: string;
  /** the body lines, each still carrying its leading ' ', '-', '+' or '\' */
  readonly lines: readonly string[];
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/** A file's diff, split into the part every patch needs and the hunks. */
export interface ParsedDiff {
  /**
   * The `diff --git`, `---` and `+++` lines (and any mode/rename lines).
   *
   * ⚠️ **CARRIED VERBATIM RATHER THAN REBUILT.** A rename, a mode change or a new
   * file all put extra lines here, and a header this module composed from a path
   * would silently drop them — producing a patch that applies to the wrong thing,
   * or does not apply at all, for a file git described perfectly well.
   */
  readonly header: readonly string[];
  readonly hunks: readonly Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split one file's unified diff into hunks.
 *
 * ⚠️ **`\ No newline at end of file` BELONGS TO THE LINE ABOVE IT AND MUST TRAVEL
 * WITH IT.** It is not a hunk line and it is not context: it is a note about the
 * preceding `-` or `+`. Dropped from a synthesised patch, apply either refuses or
 * silently adds a trailing newline the user never typed.
 */
export function parseDiff(diff: string): ParsedDiff {
  const lines = diff.split('\n');
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let current: { header: string; lines: string[]; m: RegExpMatchArray } | null = null;
  const flush = (): void => {
    if (!current) return;
    hunks.push({
      header: current.header,
      lines: current.lines,
      oldStart: Number(current.m[1]),
      // ⚠️ AN ABSENT COUNT MEANS ONE, NOT ZERO. `@@ -2 +2 @@` is git's spelling
      // for a single-line range, and reading it as 0 makes every zero-context
      // patch claim to replace nothing.
      oldCount: current.m[2] === undefined ? 1 : Number(current.m[2]),
      newStart: Number(current.m[3]),
      newCount: current.m[4] === undefined ? 1 : Number(current.m[4]),
    });
    current = null;
  };
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      flush();
      current = { header: line, lines: [], m };
      continue;
    }
    if (current) {
      // A hunk body line starts with ' ', '-', '+' or '\'. Anything else is the
      // start of the NEXT file's header in a multi-file diff, which ends this one.
      if (/^[ \-+\\]/.test(line)) {
        current.lines.push(line);
        continue;
      }
      /**
       * ⚠️ **AN EMPTY LINE IS THE OUTPUT'S TRAILING NEWLINE, NOT A BLANK CONTEXT
       * LINE — AND THE FIRST VERSION OF THIS PARSER GOT IT BACKWARDS.** It pushed
       * `' '`, which appended a phantom context line to EVERY hunk: the counts
       * came out one too high, `isZeroContext` said false for a zero-context
       * patch, and six tests failed at once. git spells a blank context line as a
       * single SPACE (it always emits the marker), so a genuinely empty line can
       * only be the newline `git diff` ends with.
       *
       * Skipped rather than treated as the end, so a stray blank cannot truncate
       * a hunk that still has lines after it.
       */
      if (line === '') continue;
      flush();
      break;
    }
    if (line !== '') header.push(line);
  }
  flush();
  return { header, hunks };
}

/**
 * A patch containing exactly these hunks of this file.
 *
 * ⚠️ **THE TRAILING NEWLINE IS LOAD-BEARING.** `git apply` reading a patch whose
 * last line has no terminator reports *"corrupt patch at line N"* — a failure that
 * looks like a parsing bug in our synthesis and is actually one missing byte.
 */
export function patchFor(parsed: ParsedDiff, hunks: readonly Hunk[]): string {
  const out = [...parsed.header];
  for (const h of hunks) {
    out.push(h.header, ...h.lines);
  }
  return `${out.join('\n')}\n`;
}

// ── LINE-LEVEL SELECTION IS *NOT* HERE, AND THIS IS THE RECORD OF WHY ─────────
//
// ⚠️⚠️ **IT WAS BUILT, IT APPLIED CLEANLY, AND IT PUT THE WRONG CONTENT IN THE
// INDEX. A test against real git is what caught it.** The naive algorithm — and
// it is the one every description of this problem gives — is:
//
//   * an unselected `+` line is DROPPED;
//   * an unselected `-` line becomes CONTEXT, because the user is not deleting it.
//
// That is correct line by line and wrong as a whole, **because of the order git
// writes a hunk in.** Measured:
//
//     @@ -1,3 +1,3 @@
//     -one
//     -two        <- git groups ALL deletions...
//     +ONE        <- ...and only then the additions
//     +TWO
//      three
//
// Picking "delete `one`" and "add `ONE`" turns `-two` into context, and that
// context line lands BETWEEN `-one` and `+ONE`. The body is then internally
// consistent — both sides' counts are right, so `git apply` ACCEPTS it — but the
// new side reads `two, ONE, three`. The index ended up holding
// `two\nONE\nthree\n` for a user who asked for `ONE\ntwo\nthree\n`.
//
// **That is the worst failure available in this item**: not a refusal, a silent
// wrong answer in the user's index. Reordering does not fix it either — emitting
// the selected `+` first works for that example and breaks the mirror case, and
// the old side's line order is checked against the file so it cannot be permuted.
//
// ⚠️ **AND IT EXPLAINS WHAT `--unidiff-zero` WAS REALLY FOR.** The design record's
// §4 line pairs it with this item, and an earlier version of this comment called
// passing it conditionally a "deliberate deviation, strictly safer". That had the
// reason backwards: **per-line, ZERO-CONTEXT hunks are the mechanism selection
// needs** — one hunk per picked line, `@@ -N,1 +N,0 @@` for a deletion and
// `@@ -M,0 +M,1 @@` for an addition — and `--unidiff-zero` is what lets apply
// accept them. Editing hunk bodies was the wrong approach, not a near-miss.
//
// So this item ships **whole-hunk staging**, which is screen 8's headline, is
// measured correct, and cannot put anything unexpected in the index. **Line-level
// selection is filed with the mechanism named** rather than shipped on an
// algorithm that has been demonstrated to lie. The conditional in `applyArgs`
// stays, because whole-hunk patches genuinely should keep their context check.

/** Does this patch carry no context at all? */
export function isZeroContext(hunks: readonly Hunk[]): boolean {
  return hunks.length > 0 && hunks.every((h) => h.lines.every((l) => l[0] !== ' '));
}

/**
 * How to ask git to apply a synthesised patch.
 *
 * ⚠️ **`--cached` AND NOTHING ELSE TOUCHES THE WORKING TREE**, which is the whole
 * safety story of this item: the user's files on disk are never written by it.
 * (`--index` would update both; `--3way` would try to merge. Neither is wanted.)
 *
 * ⚠️ **AND `--unidiff-zero` ONLY WHEN THE PATCH REALLY HAS NO CONTEXT.** The
 * design record's §4 line passes it always; it disables apply's context check,
 * which a zero-context patch (line-level selection) cannot pass and which is the
 * main thing protecting a whole-hunk patch from applying in the wrong place. So it
 * is conditional, which is strictly safer than the literal wording and is recorded
 * here as a deliberate deviation rather than an oversight.
 */
export function applyArgs(opts: { reverse?: boolean; zeroContext?: boolean } = {}): string[] {
  const args = ['apply', '--cached'];
  if (opts.zeroContext) args.push('--unidiff-zero');
  if (opts.reverse) args.push('-R');
  // `-` is the patch on stdin, and it goes last.
  args.push('-');
  return args;
}

/** The diff one file's hunks are read from — full context, worktree against index. */
export function hunkDiffArgs(path: string): string[] | undefined {
  const safe = safeGitPath(path);
  if (safe === undefined) return undefined;
  return [
    'diff',
    // ⚠️ **NO COLOUR, NO EXTERNAL DIFF, NO TEXTCONV, NO RENAME DETECTION.** Every
    // one of those changes the BYTES we are about to re-synthesise and hand back
    // to `apply`: a colour code, somebody's `difftool`, a textconv filter turning
    // a binary into prose, or a rename header that makes the patch describe two
    // paths. The same set `numstatArgs` carries, and for the same reason.
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--',
    safe,
  ];
}
