// Tree mode's rules (E24 Git v2 item 8).
//
// ⚠️ **THE COMPRESSION RULE IS THE WHOLE ITEM, SO MOST OF THESE ARE ABOUT ITS
// EDGES.** Screen 2 asks for `src/renderer/src/components` as ONE row rather than
// four, and the interesting part is not the happy path — it is the two shapes that
// look compressible and are not, because getting either wrong moves a file to a
// directory it is not in. That is a confident wrong answer about where your code
// lives, which is the failure mode this epic keeps being corrected for.
import { describe, it, expect } from 'vitest';
import { allFolderKeys, buildScmTree, type ScmTreeFolder } from './scm-tree';
import { splitPath, type ScmRow } from './scm-groups';

/** A row with only the fields the tree reads. */
function row(path: string): ScmRow {
  const { name, dir } = splitPath(path);
  return {
    path,
    name,
    dir,
    letter: 'M',
    group: 'unstaged',
    file: { path, staged: false, unstaged: true, untracked: false },
    stat: null,
  };
}

const build = (paths: string[], closed: string[] = [], scope = ''): ReturnType<typeof buildScmTree> =>
  buildScmTree(paths.map(row), new Set(closed), scope);

/** The drawn shape, as `depth:label` / `depth:name`, which is what a reader checks. */
const shape = (rows: ReturnType<typeof buildScmTree>): string[] =>
  rows.map((r) => (r.type === 'folder' ? `${r.depth}:${r.label}/` : `${r.depth}:${r.row.name}`));

const folders = (rows: ReturnType<typeof buildScmTree>): ScmTreeFolder[] =>
  rows.filter((r): r is ScmTreeFolder => r.type === 'folder');

describe('tree mode', () => {
  it('folds changed files by directory (the done-when)', () => {
    expect(shape(build(['docs/DESIGN.md', 'docs/PHILOSOPHY.md', 'PROGRESS.md']))).toEqual([
      '0:docs/',
      '1:DESIGN.md',
      '1:PHILOSOPHY.md',
      '0:PROGRESS.md',
    ]);
  });

  it('⚠️ COMPRESSES A SINGLE-CHILD CHAIN INTO ONE ROW — screen 2 by name', () => {
    // The design record's own example: four nested rows become one.
    expect(
      shape(
        build([
          'src/renderer/src/components/FeedView.tsx',
          'src/renderer/src/components/FeedView.test.tsx',
        ])
      )
    ).toEqual([
      '0:src/renderer/src/components/',
      '1:FeedView.test.tsx',
      '1:FeedView.tsx',
    ]);
  });

  it('⚠️ STOPS COMPRESSING WHERE THE TREE BRANCHES', () => {
    // `src` has three children now, so it is a row of its own and each branch
    // compresses on its own below it.
    expect(
      shape(
        build([
          'src/renderer/src/components/FeedView.tsx',
          'src/shared/ipc/capabilities.ts',
          'src/preload/index.ts',
        ])
      )
    ).toEqual([
      '0:src/',
      '1:preload/',
      '2:index.ts',
      '1:renderer/src/components/',
      '2:FeedView.tsx',
      '1:shared/ipc/',
      '2:capabilities.ts',
    ]);
  });

  it('⚠️ A DIRECTORY WITH ONE CHILD DIRECTORY **AND A FILE OF ITS OWN** IS NOT COMPRESSED', () => {
    // The first shape that looks compressible and is not: `docs` holds one
    // subdirectory and one file, and the file has to be drawn somewhere. Folding
    // `docs/plans` into `docs` would leave `DESIGN.md` claiming to be in a
    // directory it is not in.
    expect(shape(build(['docs/DESIGN.md', 'docs/plans/06-phase-3-ide.md']))).toEqual([
      '0:docs/',
      '1:plans/',
      '2:06-phase-3-ide.md',
      '1:DESIGN.md',
    ]);
  });

  it('⚠️ A DIRECTORY WITH ONE **FILE** IN IT IS NOT COMPRESSION AT ALL', () => {
    // The second shape, and the subtler one: one child, but the child is a file.
    // Folding the two together would put a status letter and a `+/−` on something
    // that is a place rather than a change.
    expect(shape(build(['src/main/git/git-log.ts']))).toEqual([
      '0:src/main/git/',
      '1:git-log.ts',
    ]);
  });

  it('a count on a folder is every file beneath it, at any depth', () => {
    const tree = build([
      'src/a/one.ts',
      'src/a/two.ts',
      'src/b/deep/three.ts',
      'src/top.ts',
    ]);
    const byPath = new Map(folders(tree).map((f) => [f.path, f.count]));
    expect(byPath.get('src')).toBe(4);
    expect(byPath.get('src/a')).toBe(2);
    expect(byPath.get('src/b/deep')).toBe(1);
  });

  it('⚠️ A FOLDED FOLDER STILL SAYS HOW MUCH IS HIDDEN', () => {
    // Which is the whole reason folding is safe: the row keeps its count, so a
    // collapsed tree never understates what has changed.
    const tree = build(['src/a/one.ts', 'src/a/two.ts', 'top.ts'], ['src/a']);
    expect(shape(tree)).toEqual(['0:src/a/', '0:top.ts']);
    expect(folders(tree)[0]).toMatchObject({ path: 'src/a', count: 2, open: false });
  });

  it('⚠️ A FOLDED ANCESTOR HIDES DESCENDANT **FOLDERS**, not just files', () => {
    const tree = build(['src/a/deep/one.ts', 'src/a/two.ts', 'src/b/three.ts'], ['src/a']);
    expect(shape(tree)).toEqual(['0:src/', '1:a/', '1:b/', '2:three.ts']);
  });

  it('folders come before files at every level, each A→Z case-insensitively', () => {
    expect(shape(build(['zeta.ts', 'Alpha.ts', 'beta/one.ts', 'Aardvark/two.ts']))).toEqual([
      '0:Aardvark/',
      '1:two.ts',
      '0:beta/',
      '1:one.ts',
      '0:Alpha.ts',
      '0:zeta.ts',
    ]);
  });

  it('⚠️ TWO NAMES THAT DIFFER ONLY IN CASE KEEP A STABLE ORDER', () => {
    // A case-insensitive compare alone makes these EQUAL, and a comparator that
    // returns 0 for two different names leaves their order to the sort's
    // internals — so the list could reorder between two renders of one answer.
    const once = shape(build(['readme.md', 'README.md']));
    const twice = shape(build(['README.md', 'readme.md']));
    expect(once).toEqual(twice);
    expect(once).toHaveLength(2);
  });

  it('a repository whose every change is at the root grows no folders', () => {
    const tree = build(['PROGRESS.md', 'package.json']);
    expect(folders(tree)).toHaveLength(0);
    expect(shape(tree)).toEqual(['0:package.json', '0:PROGRESS.md']);
  });

  it('nothing changed is no rows, not a bare root', () => {
    expect(build([])).toEqual([]);
  });

  it('⚠️ THE SCOPE IS WHAT LETS TWO GROUPS FOLD THE SAME DIRECTORY APART', () => {
    // Folding `docs` under Staged must not fold it under Changes — they are two
    // different lists of files that happen to share a directory name.
    const staged = build(['docs/a.md'], ['staged:docs'], 'staged:');
    const unstaged = build(['docs/a.md'], ['staged:docs'], 'unstaged:');
    expect(folders(staged)[0]).toMatchObject({ key: 'staged:docs', open: false });
    expect(folders(unstaged)[0]).toMatchObject({ key: 'unstaged:docs', open: true });
    // …and the file keys are scoped too, so React cannot see one row twice.
    expect(unstaged.find((r) => r.type === 'file')?.key).toBe('unstaged:docs/a.md');
  });

  it('a file key is the path, so a page landing underneath cannot move an expansion', () => {
    const tree = build(['src/a/one.ts']);
    expect(tree.map((r) => r.key)).toEqual(['src/a', 'src/a/one.ts']);
  });

  it('⚠️ `allFolderKeys` IS BUILT FROM A FULLY OPEN TREE, so collapse-all is idempotent', () => {
    // From the VISIBLE rows it would only reach folders whose parents happened to
    // be open, so pressing it twice would collapse more the second time.
    const paths = ['src/a/deep/one.ts', 'src/b/two.ts', 'top.ts'];
    const all = allFolderKeys(paths.map(row));
    expect(all).toEqual(['src', 'src/a/deep', 'src/b']);
    // With everything shut, asking again gives the same answer.
    expect(allFolderKeys(paths.map(row))).toEqual(all);
    // And it really does shut everything: no folder row is left open.
    expect(folders(build(paths, all)).every((f) => !f.open)).toBe(true);
  });

  it('the scope reaches `allFolderKeys` too', () => {
    expect(allFolderKeys([row('docs/a.md')], 'merge:')).toEqual(['merge:docs']);
  });

  it('carries the row through untouched, so the file row draws exactly what the flat one does', () => {
    const only = build(['src/a/one.ts']).find((r) => r.type === 'file');
    expect(only?.type).toBe('file');
    if (only?.type !== 'file') throw new Error('unreachable');
    expect(only.row).toMatchObject({ path: 'src/a/one.ts', name: 'one.ts', letter: 'M' });
  });
});
