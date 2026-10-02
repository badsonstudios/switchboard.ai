// What one commit changed, over FIXTURE BYTES (E24 Git v2 item 4).
//
// ⚠️ **THE FIRST THING THIS SUITE PINS IS THAT THE DESIGN RECORD'S COMMAND CANNOT
// WORK.** §4 item 4 names `diff --numstat --name-status -z`, and measured, in
// either flag order, `--name-status` wins and the numbers are gone — well-formed
// output with half the answer missing, which nothing would have reported.
import { describe, it, expect } from 'vitest';
import { mergeCommitFiles, nameStatusArgs, parseNameStatus } from './git-commit-files';
import { numstatArgs, parseNumstat } from './git-numstat';

/** `A\0path\0` — the ordinary shape. */
const st = (letter: string, path: string): string => `${letter}\0${path}\0`;
/** `R100\0old\0new\0` — the MEASURED rename shape: a score, then TWO paths. */
const ren = (letter: string, from: string, to: string): string => `${letter}\0${from}\0${to}\0`;

describe('the two commands are two commands', () => {
  it('⚠️ `--name-status` and `--numstat` are asked SEPARATELY, because together they are one', () => {
    // Measured: `git diff --numstat --name-status -z -M <sha>^ <sha>` emits only
    // name-status. The design record asks for that single command; a file list
    // built from it would have letters and no `+/−`, and the output is perfectly
    // well-formed so nothing would have said so.
    const letters = nameStatusArgs('abc^', 'abc');
    expect(letters).toContain('--name-status');
    expect(letters).not.toContain('--numstat');
    const numbers = numstatArgs({ left: 'abc^', right: 'abc' });
    expect(numbers).toContain('--numstat');
    expect(numbers).not.toContain('--name-status');
  });

  it('both put the two revisions LAST and carry the same rename and relative flags', () => {
    for (const args of [nameStatusArgs('L', 'R'), numstatArgs({ left: 'L', right: 'R' })]) {
      expect(args.slice(-2)).toEqual(['L', 'R']);
      // `-M` on one side only would mean the `R` row and the numbers were about
      // different files, since the two reads are merged BY PATH.
      expect(args).toContain('-M');
      // and both folder-relative, so a monorepo-package session sees its own paths
      expect(args).toContain('--relative');
      expect(args).toContain('--no-ext-diff');
    }
  });
});

describe('parseNameStatus', () => {
  it('reads the four ordinary letters (the done-when)', () => {
    const m = parseNameStatus(st('A', 'added.txt') + st('M', 'f.txt') + st('D', 'gone.txt') + st('T', 'link'));
    expect([...m.entries()]).toEqual([
      ['added.txt', { letter: 'A' }],
      ['f.txt', { letter: 'M' }],
      ['gone.txt', { letter: 'D' }],
      ['link', { letter: 'T' }],
    ]);
  });

  it('⚠️ A RENAME CARRIES A SCORE AND TWO PATHS, and the score is not the letter', () => {
    // THE CASE THIS SUITE EXISTS FOR, measured: `R100\0d/old.txt\0d/new.txt\0`. A
    // parser reading "status, path, status, path" takes `d/new.txt` as a status
    // and the file after it as its path — and every row from there on is wrong.
    const m = parseNameStatus(ren('R100', 'd/old.txt', 'd/new.txt'));
    expect([...m.entries()]).toEqual([['d/new.txt', { letter: 'R', from: 'd/old.txt' }]]);
  });

  it('a COPY has the same shape', () => {
    const m = parseNameStatus(ren('C75', 'a.ts', 'b.ts'));
    expect(m.get('b.ts')).toEqual({ letter: 'C', from: 'a.ts' });
  });

  it('⚠️ a rename does not swallow the record after it', () => {
    // Off by one in the cursor and the next real record is eaten as the rename's
    // destination — the same failure `parseNumstat` records for its own form.
    const m = parseNameStatus(st('A', 'before') + ren('R100', 'x', 'y') + st('M', 'after'));
    expect([...m.keys()].sort()).toEqual(['after', 'before', 'y']);
    expect(m.get('after')).toEqual({ letter: 'M' });
  });

  it('two renames in a row both land', () => {
    const m = parseNameStatus(ren('R100', 'a', 'b') + ren('R90', 'c', 'd'));
    expect([...m.keys()]).toEqual(['b', 'd']);
  });

  it('a path with a space survives', () => {
    expect(parseNameStatus(st('M', 'docs/my file.md')).has('docs/my file.md')).toBe(true);
  });

  it('empty output is no files, not a throw', () => {
    expect(parseNameStatus('').size).toBe(0);
  });

  it('⚠️ a field that is not a status is SKIPPED rather than guessed at', () => {
    // The alternative is attributing the rest of the stream to the wrong files,
    // which is worse than a short list.
    const m = parseNameStatus('not-a-status-lowercase\0' + st('M', 'good.txt'));
    expect([...m.keys()]).toEqual(['good.txt']);
  });

  it('a truncated record at the end does not produce a nameless row', () => {
    expect(parseNameStatus(st('M', 'f.txt') + 'A\0').size).toBe(1);
    // A rename cut off after its FIRST path. ⚠️ Written as raw bytes rather than
    // through `ren()`: calling that helper with two arguments left `to`
    // `undefined`, which stringified into a valid-looking rename to a file
    // literally named "undefined" — a fixture bug that reads as a code bug.
    expect(parseNameStatus('R100\0only-one-path\0').size).toBe(0);
  });
});

describe('mergeCommitFiles', () => {
  it('joins the letters to the numbers, by path', () => {
    const files = mergeCommitFiles(
      parseNameStatus(st('M', 'f.txt') + st('A', 'added.txt')),
      parseNumstat('2\t1\tf.txt\0' + '9\t0\tadded.txt\0')
    );
    expect(files).toEqual([
      { path: 'added.txt', letter: 'A', insertions: 9, deletions: 0 },
      { path: 'f.txt', letter: 'M', insertions: 2, deletions: 1 },
    ]);
  });

  it('⚠️ THE LETTERS ARE THE AUTHORITY on which files are in the commit', () => {
    // A path with numbers and no letter is a desync between two reads of one
    // range, and listing it would mean claiming a file the commit did not touch.
    const files = mergeCommitFiles(parseNameStatus(st('M', 'f.txt')), parseNumstat('1\t1\tghost.txt\0'));
    expect(files.map((f) => f.path)).toEqual(['f.txt']);
  });

  it('⚠️ a letter with NO numbers keeps zeroes rather than vanishing', () => {
    // A pure mode change has no lines either way, and it is still a file the
    // commit touched. The renderer draws no number for a zero-and-zero row.
    const files = mergeCommitFiles(parseNameStatus(st('M', 'f.sh')), parseNumstat(''));
    expect(files).toEqual([{ path: 'f.sh', letter: 'M', insertions: 0, deletions: 0 }]);
  });

  it('carries `from` for a rename, and the BINARY flag', () => {
    const files = mergeCommitFiles(
      parseNameStatus(ren('R100', 'old.png', 'new.png')),
      parseNumstat('-\t-\t\0old.png\0new.png\0')
    );
    expect(files).toEqual([
      { path: 'new.png', letter: 'R', from: 'old.png', insertions: 0, deletions: 0, binary: true },
    ]);
  });

  it('sorts by path, so the list is stable between renders', () => {
    const files = mergeCommitFiles(
      parseNameStatus(st('M', 'z.ts') + st('M', 'a.ts') + st('M', 'm.ts')),
      parseNumstat('')
    );
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('nothing at all is an empty list', () => {
    expect(mergeCommitFiles(new Map(), new Map())).toEqual([]);
  });
});
