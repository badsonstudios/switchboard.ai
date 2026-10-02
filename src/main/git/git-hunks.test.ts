// Synthesising a smaller patch (E24 Git v2 item 14).
//
// ⚠️ **THE RISKIEST PURE CODE IN THE EPIC, because its failure mode is a patch
// that APPLIES AND IS WRONG.** A hunk whose counts do not describe the file is
// usually refused — but a patch that is merely *off* can land at an offset, and
// then the index holds something the user never chose. So the counts are asserted
// arithmetically here, and `git-service.test.ts` drives the bytes through real
// `git apply` to prove git itself accepts them.
import { describe, it, expect } from 'vitest';
import { applyArgs, hunkDiffArgs, isZeroContext, parseDiff, patchFor } from './git-hunks';

/** A single newline, named rather than escaped. */
const LF = String.fromCharCode(10);

/** The measured two-hunk diff from the probe, verbatim. */
const TWO_HUNKS = [
  'diff --git a/f.txt b/f.txt',
  'index c9e9e05..d96039a 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,4 +1,4 @@',
  '-one',
  '+ONE',
  ' two',
  ' three',
  ' four',
  '@@ -7,4 +7,4 @@ six',
  ' seven',
  ' eight',
  ' nine',
  '-ten',
  '+TEN',
  '',
].join(LF);

describe('parsing a unified diff', () => {
  it('splits the header from the hunks (the done-when)', () => {
    const d = parseDiff(TWO_HUNKS);
    expect(d.header).toEqual([
      'diff --git a/f.txt b/f.txt',
      'index c9e9e05..d96039a 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
    ]);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 4, newStart: 1, newCount: 4 });
    expect(d.hunks[0].lines).toEqual(['-one', '+ONE', ' two', ' three', ' four']);
    // …and the second hunk's trailing section marker is kept on its header
    expect(d.hunks[1].header).toBe('@@ -7,4 +7,4 @@ six');
  });

  it('⚠️ AN ABSENT COUNT MEANS ONE, NOT ZERO', () => {
    // `@@ -2 +2 @@` is git's spelling for a single-line range — measured, it
    // really does emit that on a `-U0` diff. Reading it as 0 makes every
    // zero-context patch claim to replace nothing.
    const d = parseDiff(['--- a/f', '+++ b/f', '@@ -2 +2 @@ one', '-two', '+TWO', ''].join(LF));
    expect(d.hunks[0]).toMatchObject({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 });
  });

  it('⚠️ A TRAILING EMPTY LINE IS THE OUTPUT’S NEWLINE, NOT A BLANK CONTEXT LINE', () => {
    // ⚠️ **THE FIRST VERSION OF THIS PARSER GOT IT BACKWARDS** and pushed `' '`,
    // appending a phantom context line to EVERY hunk: the counts came out one too
    // high and `isZeroContext` said false for a zero-context patch. Six tests
    // failed at once, which is the one shape of this mistake that announces
    // itself. git spells a blank context line as a single SPACE — it always emits
    // the marker — so a genuinely empty line can only be the terminator.
    const d = parseDiff(['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-a', '+A', ''].join(LF));
    expect(d.hunks[0].lines).toEqual(['-a', '+A']);
    expect(d.hunks[0].oldCount).toBe(1);
  });

  it('keeps the no-newline marker, which belongs to the line above it', () => {
    const d = parseDiff(
      [
        '--- a/f',
        '+++ b/f',
        '@@ -1,1 +1,1 @@',
        '-a',
        '\\ No newline at end of file',
        '+a',
        '',
      ].join(LF)
    );
    expect(d.hunks[0].lines).toContain('\\ No newline at end of file');
  });

  it('a diff with no hunks is empty rather than a throw', () => {
    expect(parseDiff('').hunks).toEqual([]);
    expect(parseDiff(`diff --git a/f b/f${LF}`).hunks).toEqual([]);
  });

  it('stops at the next FILE, so one file’s hunks never absorb another’s', () => {
    const two = [
      '--- a/one',
      '+++ b/one',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      'diff --git a/two b/two',
      '--- a/two',
      '+++ b/two',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
      '',
    ].join(LF);
    const d = parseDiff(two);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].lines).toEqual(['-a', '+A']);
  });
});

describe('building a patch', () => {
  it('carries the header VERBATIM rather than rebuilding it', () => {
    // A rename, a mode change or a new file all put extra lines in that header. A
    // header composed from a path would drop them, producing a patch that applies
    // to the wrong thing — or not at all — for a file git described perfectly.
    const d = parseDiff(TWO_HUNKS);
    const patch = patchFor(d, [d.hunks[0]]);
    expect(patch).toContain('index c9e9e05..d96039a 100644');
    expect(patch.startsWith(`diff --git a/f.txt b/f.txt${LF}`)).toBe(true);
  });

  it('⚠️ ENDS WITH A NEWLINE, which is one byte between working and "corrupt patch"', () => {
    const d = parseDiff(TWO_HUNKS);
    expect(patchFor(d, d.hunks).endsWith(LF)).toBe(true);
  });

  it('contains ONLY the hunks it was given', () => {
    const d = parseDiff(TWO_HUNKS);
    const first = patchFor(d, [d.hunks[0]]);
    expect(first).toContain('+ONE');
    expect(first).not.toContain('+TEN');
    const second = patchFor(d, [d.hunks[1]]);
    expect(second).toContain('+TEN');
    expect(second).not.toContain('+ONE');
  });
});

describe('⚠️⚠️ why line-level selection is NOT in this item', () => {
  // ⚠️ **IT WAS BUILT, IT APPLIED CLEANLY, AND IT PUT THE WRONG CONTENT IN THE
  // USER'S INDEX.** These tests are the counter-example, kept so that nobody —
  // including a later me — re-implements the naive algorithm, which is the one
  // every description of this problem reaches for first.
  //
  // The naive rule: an unselected `+` is DROPPED, an unselected `-` becomes
  // CONTEXT (the user is not deleting it, so it is still there afterwards). That
  // is correct line by line and wrong as a whole, because of the ORDER git writes
  // a hunk in.
  it('git groups ALL deletions before ALL additions — which is what breaks it', () => {
    // Measured, not assumed: this is `git diff`'s real output for a two-line
    // change, and that ordering is the whole problem.
    const real = parseDiff(
      [
        '--- a/g.txt',
        '+++ b/g.txt',
        '@@ -1,3 +1,3 @@',
        '-one',
        '-two',
        '+ONE',
        '+TWO',
        ' three',
        '',
      ].join(LF)
    );
    expect(real.hunks[0].lines).toEqual(['-one', '-two', '+ONE', '+TWO', ' three']);
  });

  it('⚠️ SO THE NAIVE TRANSFORM MAKES A VALID PATCH THAT MEANS THE WRONG THING', () => {
    // Pick "delete `one`" and "add `ONE`". The naive rule turns `-two` into
    // context, and that context line lands BETWEEN `-one` and `+ONE`:
    //
    //     -one
    //      two      <- was `-two`, now context
    //     +ONE
    //      three
    //
    // Both sides' counts are correct, so `git apply` ACCEPTS it — and reading the
    // NEW side gives `two, ONE, three`. The index really did end up holding that
    // for a user who asked for `ONE, two, three`, and a test against real git is
    // what caught it.
    const naive = ['-one', ' two', '+ONE', ' three'];
    const oldSide = naive.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1));
    const newSide = naive.filter((l) => l[0] === ' ' || l[0] === '+').map((l) => l.slice(1));
    // the old side is right, which is exactly why apply accepts it…
    expect(oldSide).toEqual(['one', 'two', 'three']);
    // …and the new side is NOT what the user chose. The bug, asserted.
    expect(newSide).toEqual(['two', 'ONE', 'three']);
    expect(newSide).not.toEqual(['ONE', 'two', 'three']);
  });

  it('⚠️ AND REORDERING DOES NOT RESCUE IT — the mirror case breaks instead', () => {
    // Emitting the selected `+` before the converted context fixes the example
    // above and breaks its mirror (pick "delete `two`", "add `TWO`"), because the
    // OLD side's line order is checked against the file and so cannot be
    // permuted. There is no ordering of an edited hunk body that is right for
    // both.
    const reordered = ['+TWO', ' one', '-two', ' three'];
    const newSide = reordered.filter((l) => l[0] === ' ' || l[0] === '+').map((l) => l.slice(1));
    expect(newSide).toEqual(['TWO', 'one', 'three']);
    expect(newSide).not.toEqual(['one', 'TWO', 'three']);
  });

  it('the mechanism selection really needs is per-line ZERO-CONTEXT hunks', () => {
    // One hunk per picked line — `@@ -N,1 +N,0 @@` for a deletion, `@@ -M,0 +M,1
    // @@` for an addition — which is precisely what `--unidiff-zero` exists to let
    // apply accept. That is what the design record's §4 line was really about;
    // this file's own first draft had the reason backwards and called passing it
    // conditionally a "safer deviation". `isZeroContext` and the flag are both
    // already here, so the follow-up is a synthesiser rather than new plumbing.
    const perLine = parseDiff(['--- a/g', '+++ b/g', '@@ -1 +1 @@', '-one', '+ONE', ''].join(LF));
    expect(isZeroContext(perLine.hunks)).toBe(true);
    expect(applyArgs({ zeroContext: true })).toContain('--unidiff-zero');
  });
});

describe('how git is asked to apply it', () => {
  it('⚠️ `--cached` AND NOTHING THAT TOUCHES THE WORKING TREE', () => {
    // The whole safety story of this item: the user's files on disk are never
    // written by it, so nothing can be lost and no confirm is needed.
    const args = applyArgs();
    expect(args).toEqual(['apply', '--cached', '-']);
    expect(args).not.toContain('--index');
    expect(args).not.toContain('--3way');
  });

  it('reverse-applies to UNSTAGE, which is the same patch the other way', () => {
    expect(applyArgs({ reverse: true })).toEqual(['apply', '--cached', '-R', '-']);
  });

  it('keeps the context check for a whole-hunk patch', () => {
    // It is the main thing protecting a whole-hunk patch from landing in the
    // wrong place, and a whole-hunk patch carries the context to pass it.
    expect(applyArgs()).not.toContain('--unidiff-zero');
  });

  it('`-` is always last, so the patch is read from stdin', () => {
    for (const o of [{}, { reverse: true }, { zeroContext: true, reverse: true }]) {
      const args = applyArgs(o);
      expect(args[args.length - 1]).toBe('-');
    }
  });

  it('does not mistake a normal patch for a zero-context one', () => {
    expect(isZeroContext(parseDiff(TWO_HUNKS).hunks)).toBe(false);
    // no hunks is not "zero context", it is nothing
    expect(isZeroContext([])).toBe(false);
  });
});

describe('the diff a hunk list is read from', () => {
  it('⚠️ REFUSES EVERY BYTE-CHANGING OPTION, because the bytes go back to `apply`', () => {
    // A colour code, somebody's `difftool`, a textconv filter or a rename header
    // all change what we are about to re-synthesise and hand back to git.
    const args = hunkDiffArgs('src/a.ts');
    expect(args).toEqual([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--',
      'src/a.ts',
    ]);
  });

  it('⚠️ AND REFUSES A PATH IT WOULD NOT ACT ON, with the same rule as every write', () => {
    for (const bad of ['../escape.ts', '/etc/passwd', ':(exclude)x', 'C:/Windows']) {
      expect(hunkDiffArgs(bad), `${bad} was accepted`).toBeUndefined();
    }
  });
});
