// Per-file `+/−`, as a COMMAND SHAPE and a PURE PARSER (E24 Git v2 item 7, §5.7).
//
// Screen 1's rows show two numbers each, and design §4 says item 7 ships WITH
// item 6 rather than after it: *"regrouping the sidebar without per-file stats
// leaves an empty slot in every row."*
//
// Split out for the reason `git-log.ts` is: the framing is the hard part, and it
// is measurable against fixture bytes rather than against whatever changes a test
// repository happens to have.
//
// ⚠️ **THE FRAMING HAS A CASE THAT LOOKS LIKE TWO RECORDS AND IS ONE. MEASURED,
// AND A NAIVE PARSER GETS IT SILENTLY WRONG:**
//
//     ordinary   `2\t1\tf.txt\0`
//     binary     `-\t-\tbin.dat\0`
//     RENAME     `0\t0\t\0f.txt\0renamed.txt\0`
//
// A rename's path field is **empty**, and the old and new paths follow as **two
// more NUL-terminated fields**. Split on NUL and read each chunk as a record and
// you get: one record with no path, then `f.txt` with no numbers, then
// `renamed.txt` with no numbers — three wrong rows where there should be one, and
// nothing anywhere says so. `git mv` is a thing agents do constantly.

/** The two numbers for one file, on one side of the comparison. */
export interface NumStat {
  insertions: number;
  deletions: number;
  /**
   * git printed `-` for both counts.
   *
   * ⚠️ **A FACT, NOT A ZERO.** git cannot count lines in a binary file, so it
   * says so — and a row reading `+0 −0` for a changed image is a confident wrong
   * answer, where "binary" is the true one. The renderer draws a marker.
   */
  binary?: boolean;
}

/**
 * Everything `--numstat` said about one path.
 *
 * ⚠️ **A `totalFor` HELPER USED TO LIVE AT THE BOTTOM OF THIS FILE AND WAS DEAD
 * CODE** — exported, carrying four tests, called from nowhere (review). Its
 * documented purpose was "what to draw when a row is shown once rather than in
 * two groups", and that case does not occur: the sidebar always draws per group,
 * which is the whole point of keeping the two sides apart. Deleted rather than
 * kept "for later", because a tested export that nothing calls reads as a
 * contract somebody is relying on.
 */
export interface FileStats {
  /** working tree vs index — the UNSTAGED half of the row */
  unstaged?: NumStat;
  /** index vs HEAD — the STAGED half */
  staged?: NumStat;
}

/**
 * The argv for one side.
 *
 * - **`-z`** NUL-frames the paths, which is the only safe thing to do with a
 *   path: a filename may contain a newline, and without `-z` git would quote it
 *   instead — producing a path that is not the one on disk and therefore not the
 *   one `status --porcelain=v2 -c core.quotePath=off` reported beside it.
 * - **`-M`** so a rename is ONE record rather than a delete plus an add. Not a
 *   nicety: porcelain v2 detects renames (its `2 ` entries), so without `-M` the
 *   stats and the status would disagree about how many files changed, and the
 *   sidebar draws them in the same row.
 * - ⚠️ **`--relative`, AND WITHOUT IT THE NUMBERS SILENTLY VANISH FOR ANY SESSION
 *   BELOW THE REPOSITORY ROOT (found in review, measured).** The two commands do
 *   not agree on what a path is relative to.
 *
 *   ⚠️ **AND IT APPLIES TO THE COMMIT-RANGE FORM TOO**, which is why item 4's file
 *   list and its numbers both come out folder-relative: a session on a monorepo
 *   package must see its own paths in a commit's file list, not the repository's.
 *   Measured table:
 *
 *   | run from | `status --porcelain=v2` | `diff --numstat` |
 *   |---|---|---|
 *   | the repo root | `sub/deep/f.txt` | `sub/deep/f.txt` |
 *   | `sub/` | **`deep/f.txt`** | **`sub/deep/f.txt`** |
 *
 *   `status` honours `status.relativePaths`, which defaults to TRUE, so its paths
 *   are CWD-relative; `diff` is repo-root-relative unless told otherwise. They
 *   agree only when the session folder IS the top level. For a session rooted in a
 *   monorepo package — an ordinary shape here — every `stats` key missed every
 *   `files[].path`, so **every row drew nothing and the totals bar called
 *   everything uncounted**, with no reason anywhere. The one bug in this item that
 *   produced a wholly wrong surface whose only symptom was absence.
 *
 *   Measured: `--relative` from `sub/` yields `deep/f.txt`, which matches status.
 *   Both sides are now PINNED rather than left to config, because `diff.relative`
 *   and `status.relativePaths` are repo-writable and either one flipping would
 *   break the match again — which is #776's threat model pointed at a number.
 * - **`--no-color` / `--no-textconv` / `--no-ext-diff`** for the reason `diff()`
 *   records: `--no-ext-diff` is the security-relevant one (`diff.external` runs
 *   otherwise), and `--numstat` DOES diff the working tree, so unlike
 *   `log --shortstat` these are load-bearing here and the caller pays the #776
 *   config guard.
 */
export function numstatArgs(side: 'unstaged' | 'staged' | { left: string; right: string }): string[] {
  return [
    'diff',
    ...(side === 'staged' ? ['--cached'] : []),
    '--numstat',
    '-z',
    '-M',
    '--relative',
    '--no-color',
    '--no-textconv',
    '--no-ext-diff',
    // A COMMIT RANGE (E24 Git v2 item 4), when asked for one. Last, after the
    // flags, and with no `--` because both sides are revisions and there is no
    // pathspec — `diffBaseFor` has already substituted the empty tree for a root
    // commit, which is the case that otherwise shows an empty diff with no
    // explanation.
    ...(typeof side === 'object' ? [side.left, side.right] : []),
  ];
}

/**
 * Parse one `--numstat -z` stream into path → numbers.
 *
 * Walks FIELDS rather than records, because the rename case makes those two
 * different things — see the file header. A field that is not a well-formed
 * record is skipped rather than guessed at: this is a decoration on a row the
 * status already decided to draw, so a number we cannot read costs the number and
 * never the row.
 */
export function parseNumstat(out: string): Map<string, NumStat> {
  const stats = new Map<string, NumStat>();
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === '') continue;
    // `<add>\t<del>\t<path>` — and `path` is empty for a rename.
    const first = field.indexOf('\t');
    if (first === -1) continue;
    const second = field.indexOf('\t', first + 1);
    if (second === -1) continue;
    const added = field.slice(0, first);
    const deleted = field.slice(first + 1, second);
    let path = field.slice(second + 1);
    if (path === '') {
      // A RENAME. The next two fields are the old path and the new one; the
      // numbers belong to the NEW path, because that is what the row is called
      // now and what every other surface will ask about.
      const to = fields[i + 2];
      i += 2;
      if (to === undefined || to === '') continue;
      path = to;
    }
    const stat = toNumStat(added, deleted);
    if (stat) stats.set(path, stat);
  }
  return stats;
}

function toNumStat(added: string, deleted: string): NumStat | null {
  // `-` for both is git saying "binary", which is an answer and not a failure.
  if (added === '-' && deleted === '-') return { insertions: 0, deletions: 0, binary: true };
  // ⚠️ **THE EMPTY STRING IS CHECKED EXPLICITLY, AND THE FIRST VERSION OF THIS
  // DID NOT — IT ONLY SAID SO IN A COMMENT.** `Number('')` is `0`, which is a safe
  // integer and is not negative, so every guard below passed it and an empty
  // field became a confident `+0 −0` over a change of unknown size. The comment
  // claiming otherwise was written in the same breath. A test caught it, which is
  // the only reason this line exists.
  if (added === '' || deleted === '') return null;
  const insertions = Number(added);
  const deletions = Number(deleted);
  if (!Number.isSafeInteger(insertions) || !Number.isSafeInteger(deletions)) return null;
  if (insertions < 0 || deletions < 0) return null;
  return { insertions, deletions };
}

/**
 * Merge the two sides into one record per path.
 *
 * TWO SIDES AND NOT ONE SUM, and the resource groups are why: screen 1 draws a
 * staged file under **Staged changes** and an unstaged one under **Changes**, and
 * a file that is BOTH appears in both groups with different numbers in each. A
 * single total would be right for neither row.
 */
export function mergeNumstats(
  unstaged: ReadonlyMap<string, NumStat>,
  staged: ReadonlyMap<string, NumStat>
): Record<string, FileStats> {
  const merged: Record<string, FileStats> = {};
  for (const [path, stat] of unstaged) merged[path] = { unstaged: stat };
  for (const [path, stat] of staged) merged[path] = { ...merged[path], staged: stat };
  return merged;
}
