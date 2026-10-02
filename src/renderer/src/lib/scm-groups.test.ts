// The source-control sidebar's shape (E24 Git v2 items 6 and 7).
//
// Pure, so the grouping and the letters are tested as RULES rather than through a
// component. These are design §1.2's first two causes of the owner's
// "everything's kind of just smashed together", so each one gets the assertion
// that would have caught it being wrong.
import { describe, it, expect } from 'vitest';
import {
  SCM_GROUP_ORDER,
  buildGroups,
  groupsOf,
  letterFor,
  letterKey,
  scmTotals,
  splitPath,
} from './scm-groups';
import type { GitFileDto, GitStatusDto } from './git-status';

const file = (over: Partial<GitFileDto> & { path: string }): GitFileDto => ({
  staged: false,
  unstaged: true,
  untracked: false,
  ...over,
});

const status = (files: GitFileDto[], stats?: GitStatusDto['stats']): GitStatusDto => ({
  isRepo: true,
  files,
  stats,
});

describe('splitPath — design §1.2 cause 2', () => {
  it('⚠️ leads with the BASENAME, because the tail is what identifies a file', () => {
    // The bug: rows rendered the full relative path with `text-overflow:
    // ellipsis`, so in a 200px rail `…/components/FeedView.tsx` and
    // `…/FeedView.test.tsx` were the same string. The rail cut off the only part
    // that told them apart.
    expect(splitPath('src/renderer/src/components/FeedView.tsx')).toEqual({
      name: 'FeedView.tsx',
      dir: 'src/renderer/src/components/',
    });
    const a = splitPath('src/renderer/src/components/FeedView.tsx');
    const b = splitPath('src/renderer/src/components/FeedView.test.tsx');
    expect(a.name).not.toBe(b.name);
  });

  it('a file at the root has no directory, and an empty string is not a slash', () => {
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });

  it('keeps the trailing slash, which is what makes a directory read as a place', () => {
    expect(splitPath('lib/x.ts').dir).toBe('lib/');
  });

  it('handles a path with a space and a dotted directory', () => {
    expect(splitPath('.github/workflows/my ci.yml')).toEqual({
      name: 'my ci.yml',
      dir: '.github/workflows/',
    });
  });
});

describe('groupsOf — design §1.2 cause 1', () => {
  it('⚠️ MERGE IS FIRST IN THE ORDER, and it is not alphabetical', () => {
    // A conflict is the only thing in the list that BLOCKS you: nothing can be
    // committed until it is resolved. Ordering it with the others buries the one
    // group that has to be dealt with first.
    expect(SCM_GROUP_ORDER[0]).toBe('merge');
    expect([...SCM_GROUP_ORDER]).toEqual(['merge', 'staged', 'unstaged', 'untracked']);
  });

  it('⚠️ a file that is staged AND modified is in TWO groups', () => {
    // The truth, and VS Code's behaviour: staging captured one thing and
    // something has happened since. Collapsing it to one group would make one of
    // the two counts a lie about what committing would do.
    expect(groupsOf(file({ path: 'a.ts', staged: true, unstaged: true }))).toEqual([
      'staged',
      'unstaged',
    ]);
  });

  it('⚠️ a CONFLICT is in `merge` and NOWHERE else, despite both flags being true', () => {
    // `staged` and `unstaged` are both true on a conflict — that is what a
    // conflict IS — so without the dedicated flag it would appear three times and
    // bury the row that blocks everything.
    expect(
      groupsOf(file({ path: 'c.ts', staged: true, unstaged: true, conflicted: true }))
    ).toEqual(['merge']);
  });

  it('an untracked file is untracked and not "changes"', () => {
    expect(groupsOf(file({ path: 'n.ts', untracked: true }))).toEqual(['untracked']);
  });

  it('staged-only and unstaged-only each land in one group', () => {
    expect(groupsOf(file({ path: 'a', staged: true, unstaged: false }))).toEqual(['staged']);
    expect(groupsOf(file({ path: 'b', staged: false, unstaged: true }))).toEqual(['unstaged']);
  });

  it('⚠️ a row with NEITHER flag still appears, rather than vanishing', () => {
    // Not a shape porcelain produces, but a row that reached here with no group
    // would simply disappear from a surface whose whole job is to list what
    // changed. Shown under the working tree, which is the wider answer.
    expect(groupsOf(file({ path: 'x', staged: false, unstaged: false }))).toEqual(['unstaged']);
  });
});

describe('letterFor', () => {
  it('⚠️ reads the side the GROUP is about, so one file can show two letters', () => {
    // `MD` — modified in the index, deleted in the worktree. It reads `M` under
    // Staged and `D` under Changes, which is exactly what it is. A single letter
    // per file would have to pick one and be wrong in the other row.
    const f = file({ path: 'a.ts', xy: 'MD', staged: true, unstaged: true });
    expect(letterFor(f, 'staged')).toBe('M');
    expect(letterFor(f, 'unstaged')).toBe('D');
  });

  it('⚠️ an untracked file is `U` and a CONFLICT is `!` — they must not share a letter', () => {
    // The first version used `A` for untracked and `U` for a conflict (review).
    // `A` is git's letter for a STAGED ADD, which real staged rows carry two
    // groups up — so an untracked row reading "A added" collided with those and
    // contradicted its own heading. And a conflict is the one row that BLOCKS
    // everything, so sharing a letter with the most harmless row there is would
    // be exactly the wrong signal.
    expect(letterFor(file({ path: 'n', untracked: true, xy: '??' }), 'untracked')).toBe('U');
    expect(letterFor(file({ path: 'c', xy: 'UU', conflicted: true }), 'merge')).toBe('!');
  });

  it('reads R for a rename and A for an addition', () => {
    expect(letterFor(file({ path: 'r', xy: 'R.', staged: true }), 'staged')).toBe('R');
    expect(letterFor(file({ path: 'a', xy: 'A.', staged: true }), 'staged')).toBe('A');
  });

  it('⚠️ falls back to M rather than to a dot or a blank', () => {
    // `xy` is absent on the card-header path, and porcelain's `.` means
    // "unchanged on this side" — which cannot be true for a row that is IN this
    // group. An empty letter would leave a hole where the status goes.
    expect(letterFor(file({ path: 'a', staged: true }), 'staged')).toBe('M');
    expect(letterFor(file({ path: 'a', xy: '.M', unstaged: true }), 'staged')).toBe('M');
  });

  it('every letter has a word, because "M" tells a screen reader nothing', () => {
    expect(letterKey('A')).toBe('added');
    expect(letterKey('D')).toBe('deleted');
    expect(letterKey('R')).toBe('renamed');
    expect(letterKey('C')).toBe('copied');
    expect(letterKey('U')).toBe('untracked');
    expect(letterKey('!')).toBe('conflicted');
    // ⚠️ `T` IS A REAL PORCELAIN LETTER and fell through to "modified" (review):
    // a file whose TYPE changed — replaced by a symlink or a directory — which is
    // worth being told rather than called a modification.
    expect(letterKey('T')).toBe('typechange');
    expect(letterKey('M')).toBe('modified');
    expect(letterKey('?')).toBe('modified');
  });
});

describe('buildGroups', () => {
  it('drops empty groups rather than drawing an empty heading', () => {
    const groups = buildGroups(status([file({ path: 'a.ts', unstaged: true })]));
    expect(groups.map((g) => g.kind)).toEqual(['unstaged']);
  });

  it('keeps the order whatever order the files arrive in', () => {
    const groups = buildGroups(
      status([
        file({ path: 'n.ts', untracked: true }),
        file({ path: 'c.ts', conflicted: true, staged: true, unstaged: true, xy: 'UU' }),
        file({ path: 's.ts', staged: true, unstaged: false, xy: 'M.' }),
      ])
    );
    expect(groups.map((g) => g.kind)).toEqual(['merge', 'staged', 'untracked']);
  });

  it('⚠️ the FILTER matches the whole path, not just the name', () => {
    // Somebody typing `lib/` means "the files in lib", and a basename-only match
    // would answer nothing at all.
    const files = [file({ path: 'src/lib/a.ts' }), file({ path: 'src/components/b.tsx' })];
    expect(buildGroups(status(files), 'lib/')[0].rows.map((r) => r.name)).toEqual(['a.ts']);
    expect(buildGroups(status(files), 'B.TSX')[0].rows.map((r) => r.name)).toEqual(['b.tsx']);
    expect(buildGroups(status(files), 'nothing-here')).toEqual([]);
  });

  it('⚠️ attaches the numbers PER GROUP, so the two rows of one file differ', () => {
    const groups = buildGroups(
      status(
        [file({ path: 'a.ts', staged: true, unstaged: true, xy: 'MM' })],
        { 'a.ts': { staged: { insertions: 9, deletions: 0 }, unstaged: { insertions: 1, deletions: 2 } } }
      )
    );
    const staged = groups.find((g) => g.kind === 'staged')!.rows[0];
    const unstaged = groups.find((g) => g.kind === 'unstaged')!.rows[0];
    expect(staged.stat).toEqual({ insertions: 9, deletions: 0 });
    expect(unstaged.stat).toEqual({ insertions: 1, deletions: 2 });
  });

  it('⚠️ an UNTRACKED row has NO numbers, not zeroes', () => {
    // `git diff` does not see an untracked file at all. `+0 −0` beside a
    // brand-new file reads as "this file is empty", which it is not.
    const groups = buildGroups(status([file({ path: 'n.ts', untracked: true })], {}));
    expect(groups[0].rows[0].stat).toBeNull();
  });

  it('no stats asked for at all means every row draws nothing', () => {
    const groups = buildGroups(status([file({ path: 'a.ts' })]));
    expect(groups[0].rows[0].stat).toBeNull();
  });

  it('nothing at all is no groups', () => {
    expect(buildGroups(null)).toEqual([]);
    expect(buildGroups(status([]))).toEqual([]);
  });
});

describe('scmTotals', () => {
  it('⚠️ counts a file ONCE even when it is two rows', () => {
    // A staged file with further unstaged changes is two rows and one file. A
    // header reading "18 files" over seventeen distinct names is the kind of small
    // untruth that teaches a user not to trust the bigger numbers.
    const t = scmTotals(
      status([file({ path: 'a.ts', staged: true, unstaged: true, xy: 'MM' }), file({ path: 'b.ts' })])
    );
    expect(t.files).toBe(2);
  });

  it('sums the lines across both sides', () => {
    const t = scmTotals(
      status([file({ path: 'a.ts', staged: true, unstaged: true })], {
        'a.ts': { staged: { insertions: 9, deletions: 1 }, unstaged: { insertions: 2, deletions: 3 } },
      })
    );
    expect(t).toMatchObject({ insertions: 11, deletions: 4, partial: false });
  });

  it('⚠️ says it is PARTIAL when something has no line count', () => {
    // A binary file, or an untracked one, or stats that were never asked for. The
    // flag is what lets the bar say "at least" instead of implying a total it
    // cannot know.
    expect(scmTotals(status([file({ path: 'n.ts', untracked: true })], {})).partial).toBe(true);
    expect(
      scmTotals(status([file({ path: 'i.png' })], { 'i.png': { unstaged: { insertions: 0, deletions: 0, binary: true } } }))
        .partial
    ).toBe(true);
    expect(scmTotals(status([file({ path: 'a.ts' })])).partial).toBe(true);
  });

  it('an empty tree is zeroes and not partial', () => {
    expect(scmTotals(status([], {}))).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
      partial: false,
      // nothing to count is not "we counted" — the bar draws no numbers
      counted: false,
    });
  });

  it('⚠️ `counted` is FALSE when nothing could be counted, so the bar draws no `+0 −0`', () => {
    // Found in review: with every file uncounted — an all-untracked tree, a tree
    // of conflicts, a failed stats read — both totals are 0 and a bar reading
    // `+0 −0` is the same "absent is not zero" lie the ROWS get right.
    expect(scmTotals(status([file({ path: 'n.ts', untracked: true })], {})).counted).toBe(false);
    expect(scmTotals(status([file({ path: 'a.ts' })])).counted).toBe(false);
    expect(
      scmTotals(status([file({ path: 'a.ts' })], { 'a.ts': { unstaged: { insertions: 3, deletions: 0 } } }))
        .counted
    ).toBe(true);
  });

  it('⚠️ a CONFLICT is UNCOUNTED — the `0 0` git prints for it is not a measurement', () => {
    // Measured: `diff --numstat` on an unmerged path emits a real `0	0	<path>`
    // — not `-`, not absence. Counting it made a tree whose only changes were
    // conflicts read `+0 −0 · 3 files` with no hedge at all.
    const t = scmTotals(
      status([file({ path: 'c.ts', conflicted: true, staged: true, unstaged: true, xy: 'UU' })], {
        'c.ts': { unstaged: { insertions: 0, deletions: 0 } },
      })
    );
    expect(t.partial).toBe(true);
    expect(t.counted).toBe(false);
  });

  it('⚠️ and a MERGE ROW shows no numbers at all', () => {
    const groups = buildGroups(
      status([file({ path: 'c.ts', conflicted: true, staged: true, unstaged: true, xy: 'UU' })], {
        'c.ts': { unstaged: { insertions: 0, deletions: 0 } },
      })
    );
    expect(groups[0].kind).toBe('merge');
    expect(groups[0].rows[0].stat).toBeNull();
  });
});
