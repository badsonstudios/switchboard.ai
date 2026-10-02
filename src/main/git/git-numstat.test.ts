// Per-file `+/−`, over FIXTURE BYTES (E24 Git v2 item 7).
//
// Every fixture is a layout MEASURED off real git (2.51.0.windows.2) and written
// down, for the reason `git-log.test.ts` gives: a test repository only produces
// the shapes its own changes happen to have, and the rename case below is the one
// that matters most and is the one a hand-written fixture gets wrong.
import { describe, it, expect } from 'vitest';
import { mergeNumstats, numstatArgs, parseNumstat, type NumStat } from './git-numstat';

/** `[add, del, path]` → the bytes git writes. */
const rec = (add: string, del: string, path: string): string => `${add}\t${del}\t${path}\0`;
/** The MEASURED rename shape: an empty path, then two more NUL fields. */
const renameRec = (add: string, del: string, from: string, to: string): string =>
  `${add}\t${del}\t\0${from}\0${to}\0`;

describe('numstatArgs', () => {
  it('asks the two sides as two different questions', () => {
    expect(numstatArgs('unstaged')).not.toContain('--cached');
    expect(numstatArgs('staged')).toContain('--cached');
  });

  it('carries the flags whose absence is a wrong answer or a hole', () => {
    for (const side of ['unstaged', 'staged'] as const) {
      const args = numstatArgs(side);
      // Without `-z` a path containing a newline is QUOTED, producing a path that
      // is not the one `status -c core.quotePath=off` reported beside it.
      expect(args).toContain('-z');
      // Without `-M` a rename is a delete plus an add, and porcelain v2 (which
      // DOES detect renames) would disagree with the numbers drawn in its row.
      expect(args).toContain('-M');
      // The security-relevant one: `diff.external` runs otherwise, and unlike
      // `log --shortstat` this really does diff the working tree (#764).
      expect(args).toContain('--no-ext-diff');
      expect(args).toContain('--no-textconv');
      expect(args).toContain('--no-color');
      // ⚠️ `--relative`, and without it the numbers silently vanish for any
      // session below the repository root: `status` is CWD-relative (it honours
      // `status.relativePaths`, default true) and `diff` is repo-root-relative, so
      // every key missed every row. Measured; see `numstatArgs`.
      expect(args).toContain('--relative');
    }
  });
});

describe('parseNumstat', () => {
  it('reads an ordinary record (the done-when)', () => {
    const m = parseNumstat(rec('2', '1', 'f.txt'));
    expect(m.get('f.txt')).toEqual({ insertions: 2, deletions: 1 });
  });

  it('reads several, and keeps the paths exactly as git wrote them', () => {
    const m = parseNumstat(rec('2', '1', 'src/a.ts') + rec('10', '0', 'docs/b md.txt'));
    expect([...m.keys()]).toEqual(['src/a.ts', 'docs/b md.txt']);
  });

  it('⚠️ a BINARY file is binary, not `+0 −0`', () => {
    // git cannot count lines in a binary file and says so with `-`. A row reading
    // zero-and-zero for a changed image is a confident wrong answer.
    expect(parseNumstat(rec('-', '-', 'logo.png')).get('logo.png')).toEqual({
      insertions: 0,
      deletions: 0,
      binary: true,
    });
  });

  it('⚠️ A RENAME IS ONE RECORD SPREAD OVER THREE FIELDS, and the numbers go to the NEW path', () => {
    // THE CASE THIS SUITE EXISTS FOR, measured: `0\t0\t\0f.txt\0renamed.txt\0`.
    // Split on NUL and read each chunk as a record and you get three wrong rows —
    // one with no path and two with no numbers — and nothing says so. `git mv` is
    // a thing agents do constantly.
    const m = parseNumstat(renameRec('3', '1', 'old/name.ts', 'new/name.ts'));
    expect([...m.keys()]).toEqual(['new/name.ts']);
    expect(m.get('new/name.ts')).toEqual({ insertions: 3, deletions: 1 });
    // and the old name is NOT a row of its own
    expect(m.has('old/name.ts')).toBe(false);
  });

  it('⚠️ a rename does not swallow the record after it', () => {
    // The fix advances the cursor by two fields; off by one and the next real
    // record is consumed as the rename's destination.
    const m = parseNumstat(
      rec('1', '0', 'before.txt') + renameRec('0', '0', 'a.ts', 'b.ts') + rec('5', '2', 'after.txt')
    );
    expect([...m.keys()].sort()).toEqual(['after.txt', 'b.ts', 'before.txt']);
    expect(m.get('after.txt')).toEqual({ insertions: 5, deletions: 2 });
  });

  it('a BINARY rename keeps both facts', () => {
    const m = parseNumstat(renameRec('-', '-', 'old.png', 'new.png'));
    expect(m.get('new.png')).toEqual({ insertions: 0, deletions: 0, binary: true });
  });

  it('empty output is no stats, not a throw', () => {
    expect(parseNumstat('').size).toBe(0);
  });

  it('⚠️ a MALFORMED field costs the number and never the row', () => {
    // These are a decoration on a row the status already decided to draw, so a
    // field we cannot read is skipped and the rest still parses.
    const m = parseNumstat('garbage-with-no-tabs\0' + rec('1', '1', 'good.txt'));
    expect([...m.keys()]).toEqual(['good.txt']);
  });

  it('⚠️ an EMPTY count is not zero', () => {
    // `Number('')` is 0 — the same trap `git-log`'s timestamp parser records.
    // Here it would draw a confident `+0 −0` over a change of unknown size.
    expect(parseNumstat('\t\tf.txt\0').size).toBe(0);
    expect(parseNumstat('1\t\tf.txt\0').size).toBe(0);
  });

  it('refuses a negative or non-integer count', () => {
    expect(parseNumstat(rec('-3', '1', 'f.txt')).size).toBe(0);
    expect(parseNumstat(rec('1.5', '1', 'f.txt')).size).toBe(0);
  });
});

describe('mergeNumstats', () => {
  const n = (insertions: number, deletions: number): NumStat => ({ insertions, deletions });

  it('⚠️ keeps the two sides APART, because the groups draw them apart', () => {
    // Screen 1 puts a staged file under "Staged changes" and an unstaged one
    // under "Changes", and a file that is BOTH appears in both groups with
    // different numbers in each. A single total would be right for neither row.
    const merged = mergeNumstats(new Map([['f.txt', n(2, 1)]]), new Map([['f.txt', n(9, 0)]]));
    expect(merged['f.txt']).toEqual({ unstaged: n(2, 1), staged: n(9, 0) });
  });

  it('a file on one side only has one side', () => {
    const merged = mergeNumstats(new Map([['a.ts', n(1, 0)]]), new Map([['b.ts', n(0, 4)]]));
    expect(merged['a.ts']).toEqual({ unstaged: n(1, 0) });
    expect(merged['b.ts']).toEqual({ staged: n(0, 4) });
  });

  it('nothing on either side is an empty record, not an undefined one', () => {
    expect(mergeNumstats(new Map(), new Map())).toEqual({});
  });
});
