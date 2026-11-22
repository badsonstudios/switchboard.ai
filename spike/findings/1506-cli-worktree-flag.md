# #1506: the CLI's `-w, --worktree` flag, measured

**Date:** 2026-11-22 · **CLI:** 2.1.322 (PATH) · **Machine:** the owner's desktop (Windows 11)

## Question

Decision 3 on #1636 says projects create worktrees with our own `git worktree
add`, not the CLI's `--worktree` flag, "because that flag ties one worktree to
one session and a project allows several", and that the flag is measured first.
Under host-don't-reimplement (P7) the flag is the first candidate, so: where
does its worktree land, what does it start from, what does resume do, how does
it look on the stream-json transport, and what is left at session end?

## Probe (`spike/probes/1506/probe-worktree-flag.sh`)

A throwaway repo in the temp dir with a bare `origin`. Local `HEAD` is on a
`feature` branch one commit ahead of local `main`; `origin/main` is a different
commit ahead of local `main`, so the worktree's base names its source. A
git-ignored `.env` sits in the checkout. Each run is one
`claude -p --model haiku --max-turns 1 --output-format stream-json --verbose`.

| Run | What happened |
|---|---|
| `--worktree probe1` | Worktree at **`<repo>/.claude/worktrees/probe1`**, on a new branch **`worktree-probe1`**, at **`origin/main`** (not `HEAD`, not local `main`). The stream-json `init` message's `cwd` is the worktree. `.env` was **not** copied. |
| after it exited | The worktree and branch **stay**. The worktree is **locked** (`claude session probe1 (pid 33720)`) and the lock outlives the process. The primary checkout now shows `?? .claude/` as untracked. |
| `--resume <id>` from the repo root | `init.cwd` is the worktree again: resume follows the session back into it. |
| `--worktree probe1` again, new session | **Reuses** the existing worktree (same cwd, no error, no second branch). |
| `--worktree` with no name | A generated name (`happy-forging-cocke`), branch `worktree-happy-forging-cocke`, also at `origin/main`. |

## The settings behind it (read from the PATH binary)

`grep -ao 'worktree:()=>u({.{0,1500}' claude.exe` shows the `worktree` block of
the settings schema:

- `baseRef`: `"fresh"` (default, `origin/<default-branch>`) or `"head"`. Nothing
  else: no named base, no existing branch.
- `symlinkDirectories`: directories symlinked from the main repo into each
  worktree, none by default. A `.worktreeinclude` file lists files to copy.
- `sparsePaths`, `bgIsolation`.
- `location`: read **only by Claude Code Desktop for SSH sessions**. The schema
  text says the CLI (`--worktree`, `EnterWorktree`, agent isolation) does not
  read it: the CLI always uses `<project>/.claude/worktrees`.
- `WorktreeCreate` / `WorktreeRemove` hooks can replace creation (the hook
  prints the directory it made).

## Conclusion: decision 3 stands, for different reasons than it gave

The stated reason is only half right. A second session **can** join a
flag-made worktree by passing the same name, so "one worktree per session" is
not literally true. The flag still does not fit, for these measured reasons:

1. **Location.** The CLI puts every worktree inside the repo, under
   `.claude/worktrees`, and the CLI ignores `worktree.location`. Decision 2
   (one app-managed folder outside the repo, changeable per project) cannot be
   met through the flag, and a folder inside the repo shows up as untracked in
   the primary checkout unless the repo ignores it.
2. **Base and branch.** Only `origin/<default>` or `HEAD`; the branch is always
   `worktree-<name>`. The new-worktree dialog offers any base ref and an
   existing branch.
3. **Ordering.** The worktree exists only once the session has started, so
   copy / share / setup cannot run before the AI's first turn. The project
   flow builds and sets up first, then starts the session in a ready folder.
4. **Configuration lives in the user's Claude settings** (`worktree.*`,
   `.worktreeinclude` in the repo). Driving it would mean writing to Dan's
   Claude config or the repo for every project setting. Project settings are
   ours and stay in `workspace.json` (local-first, nothing in the repo).
5. **Leftovers.** The worktree stays locked to a dead pid after a `-p` session
   ends, so our own removal (#1638) would have to break a lock it did not take.
6. **Providers.** Non-Claude CLIs have no such flag; our own path serves all.

Nothing here is reimplementing something the CLI keeps for itself: the CLI
does not own the worktree once it exists (resume just reads the session's
recorded cwd), and a session we start in a folder we made is an ordinary
session in an ordinary folder. **Revisit** if the CLI starts reading
`worktree.location` and accepts an arbitrary base ref: then a WorktreeCreate
hook or the flag itself could carry creation, with our setup steps around it.

## What #1506 takes from it

- Same nouns as the CLI where they agree: copy a short file list, share
  (link) opt-in directories, none by default.
- Starting from the default branch's remote tip (`origin/<default>`) when one
  exists matches the CLI's `fresh` default; the dialog's default base is that.

Cleanup: the probe's temp repo was deleted after reading; `claude agents
--json` listed no session from it (`-p` runs are not background sessions).
