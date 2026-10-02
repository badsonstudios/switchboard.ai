// The write half's rules (E24 Git v2 item 12).
//
// ⚠️ **THE COMMANDS THEMSELVES WERE MEASURED AGAINST REAL GIT BEFORE THEY WERE
// WRITTEN** — `git-write.ts` records the four findings, two of which changed the
// design. This file pins the pure part: the argv, the path refusals, the discard
// classification and the batching. `git-service.test.ts` drives the real binary.
//
// What matters most here is the ASYMMETRY the read half does not have. A refused
// path on a read widens the answer; on a write it would stage, or DISCARD, files
// the user did not name. So every refusal below is all-or-nothing on purpose, and
// the tests say so rather than leaving it to be inferred.
import { describe, it, expect } from 'vitest';
import {
  MAX_PATHS_PER_CALL,
  asPathList,
  batchPaths,
  discardTrackedArgs,
  discardUntrackedArgs,
  planDiscard,
  stageArgs,
  unstageArgs,
  writePaths,
} from './git-write';
import type { GitFileStatus } from './git-service';

const file = (over: Partial<GitFileStatus> & { path: string }): GitFileStatus => ({
  xy: '.M',
  staged: false,
  unstaged: true,
  untracked: false,
  ...over,
});

describe('the write commands', () => {
  it('stages with a plain `add --`, and NO `-A` (the done-when)', () => {
    // Measured: plain `add` already covers a deletion and an untracked file, so
    // `-A` buys nothing — and leaving it out means a bug that lost the path list
    // stages NOTHING rather than the entire tree.
    expect(stageArgs(['a.ts', 'b.ts'])).toEqual(['add', '--', 'a.ts', 'b.ts']);
    expect(stageArgs(['a.ts'])).not.toContain('-A');
  });

  it('unstages with `restore --staged`, the exact undo of stage', () => {
    expect(unstageArgs(['a.ts'])).toEqual(['restore', '--staged', '--', 'a.ts']);
  });

  it('discards a tracked path from the INDEX, so a staged change survives', () => {
    // `restore` with no `--source` restores the worktree from the index, which is
    // the correct meaning of discarding one ROW rather than the whole file.
    expect(discardTrackedArgs(['a.ts'])).toEqual(['restore', '--', 'a.ts']);
    expect(discardTrackedArgs(['a.ts'])).not.toContain('--source');
  });

  it('⚠️ DELETES AN UNTRACKED PATH WITH `clean -f` AND NEVER `-d`', () => {
    // Without `-d`, `clean` cannot remove a DIRECTORY — only files it was named.
    // Every path comes from `status`, which lists files, so `-d` would buy
    // nothing and would turn a bug in the path list into a recursive delete.
    expect(discardUntrackedArgs(['new.ts'])).toEqual(['clean', '-f', '--', 'new.ts']);
    expect(discardUntrackedArgs(['new.ts'])).not.toContain('-d');
  });

  it('every command ends its options with `--`, so no filename can become a flag', () => {
    for (const args of [
      stageArgs(['-rf']),
      unstageArgs(['-rf']),
      discardTrackedArgs(['-rf']),
      discardUntrackedArgs(['-rf']),
    ]) {
      expect(args).toContain('--');
      expect(args.indexOf('--')).toBeLessThan(args.indexOf('-rf'));
    }
  });
});

describe('which paths a write will accept', () => {
  it('takes ordinary relative paths', () => {
    expect(writePaths(['a.ts', 'src/b.ts'])).toEqual(['a.ts', 'src/b.ts']);
  });

  it('⚠️ REFUSES THE WHOLE BATCH FOR ONE BAD PATH, and that is the only safe choice', () => {
    // A destructive operation that silently applied to five of six named files is
    // the worst outcome available here: the user confirmed six and was told it
    // worked.
    const r = writePaths(['fine.ts', '../escape.ts', 'also-fine.ts']);
    expect(Array.isArray(r)).toBe(false);
    if (Array.isArray(r)) throw new Error('unreachable');
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
    expect(r.reason).toContain('will not act');
  });

  it('⚠️ REFUSES EVERY SHAPE THAT GETS THROUGH A `--`', () => {
    // `..` escapes the session folder (git resolves a pathspec against the cwd),
    // an absolute path reaches anywhere, and a leading `:` is pathspec MAGIC —
    // `:(exclude)` on a discard would invert which files are thrown away.
    for (const bad of [
      '../secret.txt',
      'src/../../secret.txt',
      '/etc/passwd',
      'C:/Windows/system32',
      ':(exclude)src',
      ':!src',
    ]) {
      expect(Array.isArray(writePaths([bad])), `${bad} was accepted`).toBe(false);
    }
  });

  it('⚠️ NAMING NOTHING IS A REFUSAL, not a no-op that reports success', () => {
    // A "stage all" on an empty selection that answered `ok` would have the
    // surface say it staged something. And `add --` with no paths is a command
    // whose behaviour depends on git's defaults, which is not a thing to find out
    // by accident.
    for (const nothing of [undefined, []]) {
      const r = writePaths(nothing);
      expect(Array.isArray(r)).toBe(false);
      if (!Array.isArray(r)) expect(r.reason).toContain('no files');
    }
  });

  it('a Windows separator is folded to git’s, and the folded form is what is passed', () => {
    expect(writePaths([`src${String.fromCharCode(92)}a.ts`])).toEqual(['src/a.ts']);
  });
});

describe('a payload off the wire', () => {
  it('⚠️ IS NOT TRUSTED TO BE A LIST OF STRINGS (#650’s discipline)', () => {
    // The renderer is not a trusted source of SHAPES. A bad payload has to become
    // a refusal, not a `TypeError` in the handler and certainly not something
    // non-string reaching argv.
    expect(asPathList(['a.ts'])).toEqual(['a.ts']);
    expect(asPathList(['a.ts', 7, null, undefined, {}, 'b.ts'])).toEqual(['a.ts', 'b.ts']);
    expect(asPathList('a.ts')).toEqual([]);
    expect(asPathList(null)).toEqual([]);
    expect(asPathList(undefined)).toEqual([]);
    expect(asPathList({ 0: 'a.ts' })).toEqual([]);
    // …and an entirely bogus payload becomes `[]`, which `writePaths` refuses.
    expect(Array.isArray(writePaths(asPathList(null)))).toBe(false);
  });

  it('drops an empty string, which would be "the whole tree" to some commands', () => {
    expect(asPathList(['', 'a.ts'])).toEqual(['a.ts']);
  });
});

describe('sorting the paths a discard needs', () => {
  const files = [
    file({ path: 'mod.ts' }),
    file({ path: 'new.ts', untracked: true, xy: '??' }),
    file({ path: 'clash.ts', conflicted: true, staged: true, unstaged: true, xy: 'UU' }),
    file({ path: 'staged.ts', staged: true, unstaged: false, xy: 'M.' }),
  ];

  it('⚠️ SPLITS TRACKED FROM UNTRACKED, because git made discard two commands', () => {
    // Measured: `git restore` REFUSES an untracked path outright, so a mixed
    // batch fails entirely. The split is not an optimisation — it is the only way
    // the operation works at all.
    const plan = planDiscard(['mod.ts', 'new.ts', 'staged.ts'], files);
    expect(plan.tracked.sort()).toEqual(['mod.ts', 'staged.ts']);
    expect(plan.untracked).toEqual(['new.ts']);
  });

  it('⚠️ A CONFLICTED PATH IS CALLED OUT BY NAME, never guessed at', () => {
    // "Discard this conflict" has at least three meanings — take ours, take
    // theirs, abandon the merge — and git has a different command for each.
    // Picking one silently would be switchboard deciding something only the user
    // can, on the one file where being wrong costs the most.
    const plan = planDiscard(['clash.ts', 'mod.ts'], files);
    expect(plan.conflicted).toEqual(['clash.ts']);
    expect(plan.tracked).toEqual(['mod.ts']);
    expect(plan.untracked).toEqual([]);
  });

  it('a path that is not in the status at all is separated, not assumed tracked', () => {
    // It is already clean — which is the state a discard was asking for. Assuming
    // it was tracked would run `restore` on a path git does not know, and
    // assuming untracked would hand it to `clean`.
    const plan = planDiscard(['gone.ts'], files);
    expect(plan.unknown).toEqual(['gone.ts']);
    expect(plan.tracked).toEqual([]);
    expect(plan.untracked).toEqual([]);
  });

  it('an empty status makes every path unknown rather than throwing', () => {
    expect(planDiscard(['a.ts'], []).unknown).toEqual(['a.ts']);
  });
});

describe('batching', () => {
  it('⚠️ EXISTS BECAUSE A COMMAND LINE HAS A LENGTH LIMIT, and Windows’ is the small one', () => {
    // ~32,767 characters for `CreateProcess`. A "stage all" on a generated-file
    // commit really can name thousands of paths, and the failure without this is
    // git never STARTING — reported as a spawn error, which reads like "git is
    // not installed".
    const many = Array.from({ length: 450 }, (_, i) => `f${i}.ts`);
    const batches = batchPaths(many);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(MAX_PATHS_PER_CALL);
    expect(batches[2]).toHaveLength(450 - 2 * MAX_PATHS_PER_CALL);
    // …and nothing is lost or repeated, which is the only thing that must be true.
    expect(batches.flat()).toEqual(many);
  });

  it('one batch for anything that fits, and none for nothing', () => {
    expect(batchPaths(['a.ts'])).toEqual([['a.ts']]);
    expect(batchPaths([])).toEqual([]);
  });
});
