// The pure half of making a worktree (E42 step 2, #1506): the argv for
// `git worktree add`, and reading the branch list the new-worktree dialog
// offers. `GitService` runs them; nothing here touches a process or a disk.
//
// Why our own `git worktree add` and not the CLI's `--worktree` flag: measured
// in `spike/findings/1506-cli-worktree-flag.md`. In short, the flag always puts
// the worktree inside the repo (`.claude/worktrees`), starts it only from
// `origin/<default>` or HEAD, and creates it only once the session has started,
// so the copy / share / setup steps could not run first.
import path from 'path';
import { isRev } from './git-log';
import { isBranchName } from './git-remote';

/**
 * `git worktree add` for a new branch from `base`, or for an existing branch.
 * null when an argument could become a flag or a range (the same rules every
 * other branch verb here keeps), or the folder is not an absolute local path.
 *
 * `--no-track`: a branch started from `origin/main` would otherwise track
 * `origin/main`, and a later push could be read as a push to main. The branch
 * gets its own upstream when it is first pushed (#1638).
 */
export function worktreeAddArgs(opts: {
  target: string;
  branch: unknown;
  newBranch: boolean;
  base?: unknown;
}): string[] | null {
  if (!isBranchName(opts.branch)) return null;
  if (!isAbsoluteLocal(opts.target)) return null;
  if (!opts.newBranch) return ['worktree', 'add', opts.target, opts.branch];
  if (opts.base !== undefined && !isRev(opts.base)) return null;
  return [
    'worktree',
    'add',
    '--no-track',
    '-b',
    opts.branch,
    opts.target,
    ...(typeof opts.base === 'string' ? [opts.base] : []),
  ];
}

/**
 * Absolute on THIS platform, and not a UNC path: a git run (or a folder made)
 * against `\\host\share` would reach a remote host. `C:\x` is not absolute
 * on Linux, where `path.join` would put it under the working folder (#1506
 * review), so the platform's own answer is required too.
 */
export function isAbsoluteLocal(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.length > 1024) return false;
  if (/^[\\/]{2}/.test(p)) return false;
  return path.isAbsolute(p);
}

/** `for-each-ref --format=%(refname) refs/heads refs/remotes` → names. */
export function parseBranchRefs(out: string): { local: string[]; remote: string[] } {
  const local: string[] = [];
  const remote: string[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const ref = raw.trim();
    if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      // `origin/HEAD` is a pointer, not a branch anyone works on
      if (!name.endsWith('/HEAD')) remote.push(name);
    }
  }
  return { local, remote };
}

/**
 * What a new worktree starts from when nobody says (the dialog's default):
 * origin's own default branch (what `origin/HEAD` points at, the same base the
 * CLI's `--worktree` uses), else `origin/main` / `origin/master`, else a local
 * `main` / `master`, else whatever HEAD is on. null in an empty repo.
 */
export function pickDefaultBase(
  refs: { local: string[]; remote: string[] },
  originHead: string | null,
  headBranch: string | null
): string | null {
  if (originHead && refs.remote.includes(originHead)) return originHead;
  for (const r of ['origin/main', 'origin/master']) if (refs.remote.includes(r)) return r;
  for (const l of ['main', 'master']) if (refs.local.includes(l)) return l;
  return headBranch;
}
