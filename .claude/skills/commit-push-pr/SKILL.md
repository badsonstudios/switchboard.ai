---
name: commit-push-pr
description: Commit the current changes, push to GitHub, and open a pull request. Always asks for explicit approval before committing or pushing. Verifies PROGRESS.md is updated and the PR references its issue when the work belongs to a work item.
user-invocable: true
---

Commit, push, and open a PR for the current work.

If the user provided a summary or PR title: $ARGUMENTS

## Step 1: Review what will be committed

```bash
git status
git diff
```

Summarize the changes for the user. If this work implements a tracked item,
confirm **`PROGRESS.md` reflects it** (the /next-item close-out) — that update
belongs in the same commit — and that the PR body will carry `Closes #<issue>`.

## Step 2: Get explicit approval

**CRITICAL: Always ask the user for approval before committing or pushing.**
Present the plan (files, branch, commit message, PR base) and wait for an
explicit "yes" — unless the user already told you in this session to
commit/push without asking again.

## Step 3: Branch (if needed)

If on `main`, create a branch first: `git checkout -b feature/<item-id-slug>`
(e.g. `feature/s-01-pty-host`; `fix/<slug>` for untracked work).

## Step 4: Commit

- Stage the intended files (`git add ...`).
- Clear, present-tense message; prefix with the item: `<item-id>: <what changed>`
  (e.g. `S-01: PTY-host the claude CLI in xterm.js`).
- Follow `references/git-workflow.md`.

## Step 5: Push and open the PR

After approval, prefer the helper script (branches if needed, commits staged
changes, pushes, opens the PR):

```bash
# bash
.claude/scripts/new-pr.sh -t "<item-id>: <title>" -b "Closes #<issue>. <body>" -B main
```
```powershell
# PowerShell
.\.claude\scripts\new-pr.ps1 -Title "<item-id>: <title>" -Body "Closes #<issue>. <body>" -Base main
```

Or by hand:

```bash
git push -u origin <branch>
gh pr create --base main --title "<item-id>: <title>" --body "Closes #<issue>. <summary>"
```

Report the PR URL. **Dan reviews and squash-merges — that's the oversight
point; never self-merge.** After merge: `git checkout main && git pull` before
the next item.

## Notes

- Never commit `.claude/.env` or other secrets. Verify nothing sensitive is staged.
- PR bodies end with the standard Claude Code attribution footer.
- No release/packaging step exists yet (Phase 4 concern).
