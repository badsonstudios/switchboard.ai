// What one commit changed (E24 Git v2 item 4, §5.7) — mockup screen 7.
//
// ⚠️ **THE DESIGN RECORD ASKS FOR ONE COMMAND AND THAT COMMAND CANNOT WORK.** §4
// item 4 names `diff --numstat --name-status -z <parent> <sha>`. Measured, in
// either flag order:
//
//     $ git diff --numstat --name-status -z -M <sha>^ <sha>
//     A\0added.txt\0R100\0d/old.txt\0d/new.txt\0M\0f.txt\0D\0gone.txt\0
//
// **`--name-status` wins and the numbers are gone entirely.** The two flags are
// mutually exclusive, so a file list built from that one command has letters and
// no `+/−` — and nothing would have said so, because the output is perfectly
// well-formed. It is two reads, and this file is the parser for the half
// `git-numstat.ts` does not already cover.
//
// ⚠️ **AND `--name-status -z` HAS THE SAME RENAME TRAP, IN A DIFFERENT SHAPE.**
// `R100\0d/old.txt\0d/new.txt\0` — the status field carries a SIMILARITY SCORE and
// is followed by **two** paths. A parser that read "status, path, status, path"
// would take `d/new.txt` as a status letter and the file after it as its path,
// and every row from there on would be wrong.

/** One file in a commit. */
export interface CommitFile {
  /** git's forward-slash relative path — the NEW name for a rename */
  path: string;
  /** M A D R C T, with any similarity score stripped */
  letter: string;
  /** where it came from, for a rename or a copy */
  from?: string;
  insertions: number;
  deletions: number;
  /** git could not count lines — a binary file */
  binary?: boolean;
}

/**
 * The argv for the letters.
 *
 * `-M` for the same reason `numstatArgs` carries it — the two reads are merged by
 * PATH, and rename detection on one side only would mean the `R` row and the
 * numbers were about different files. `--relative` likewise: a session on a
 * monorepo package must see its own paths.
 */
export function nameStatusArgs(left: string, right: string): string[] {
  return [
    'diff',
    '--name-status',
    '-z',
    '-M',
    '--relative',
    '--no-color',
    '--no-textconv',
    '--no-ext-diff',
    left,
    right,
  ];
}

/**
 * Parse `--name-status -z` into path → letter.
 *
 * Walks FIELDS in pairs, except for a rename or a copy, which is a triple. The
 * status field is `M`, `A`, `D`, `T`, or `R<score>` / `C<score>` — the score is a
 * number git appends and is not part of the letter.
 */
export function parseNameStatus(out: string): Map<string, { letter: string; from?: string }> {
  const files = new Map<string, { letter: string; from?: string }>();
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (status === '') continue;
    const letter = status[0];
    // A field that is not a status is a desync — a path we have mis-framed. Skip
    // it rather than guess: the alternative is attributing the rest of the stream
    // to the wrong files, which is worse than a short list.
    if (!/^[A-Z]/.test(letter)) continue;
    // ⚠️ R AND C CARRY A SCORE AND TWO PATHS. `R100\0old\0new\0`.
    if (letter === 'R' || letter === 'C') {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 2;
      if (!from || !to) continue;
      files.set(to, { letter, from });
      continue;
    }
    const path = fields[i + 1];
    i += 1;
    if (!path) continue;
    files.set(path, { letter });
  }
  return files;
}

/**
 * Join the letters to the numbers.
 *
 * ⚠️ **THE LETTERS ARE THE AUTHORITY ON WHICH FILES ARE IN THE COMMIT.** A path
 * with numbers and no letter is a desync between two reads of one range and is
 * dropped; a path with a letter and no numbers is an ordinary thing — a pure mode
 * change has none — and keeps zeroes rather than vanishing from the list.
 */
export function mergeCommitFiles(
  letters: ReadonlyMap<string, { letter: string; from?: string }>,
  numbers: ReadonlyMap<string, { insertions: number; deletions: number; binary?: boolean }>
): CommitFile[] {
  const files: CommitFile[] = [];
  for (const [path, { letter, from }] of letters) {
    const n = numbers.get(path);
    files.push({
      path,
      letter,
      ...(from === undefined ? {} : { from }),
      insertions: n?.insertions ?? 0,
      deletions: n?.deletions ?? 0,
      ...(n?.binary ? { binary: true } : {}),
    });
  }
  // By path, so the list is stable between the two reads and between renders. git
  // already sorts, but the merge walks a Map whose order is the letters' order and
  // tying the UI to that is tying it to an implementation detail of one command.
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
