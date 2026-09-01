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

**User-docs check (`docs/manual/`).** If the diff changes anything a user can
see or do, the matching manual page must be written/updated in this same
commit (`docs/plans/00-process.md` → User documentation). If it isn't, write it
now rather than opening the PR without it. Purely internal changes (refactor,
CI, tests) are exempt — state that explicitly instead of skipping silently.

**Hand-off check (the PR body).** Every PR body carries, above the technical
detail: a **plain-English "What this does"** (a few sentences, real button and
key names, no paths or item IDs) and a **numbered "What to test"** list as
GitHub checkboxes (`- [ ] 1. …`), noting in one line what the automated tests
already cover so Dan doesn't repeat machine work. `/next-item` Step 9 produces
both — reuse them verbatim. Arriving here without them (a direct `/commit-push-pr`
on untracked work) means writing them now, to the same rules.

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

Report the PR URL, then **merge it yourself once CI is green** —
`gh pr merge <n> --squash --delete-branch`. After merge: `git checkout main &&
git pull` before the next item.

**The gate is green CI, not a human click.** This said "Dan reviews and
squash-merges — never self-merge" until 2026-09-01, which was stale and left
finished work parked waiting on a human who does not merge. Reviews are
deliberately not required on `main`; that is a decision, not an oversight.
**Red CI does not merge**, and `--admin` is never the way past a failing check.

## Notes

- Never commit `.claude/.env` or other secrets. Verify nothing sensitive is staged.
- PR bodies end with the standard Claude Code attribution footer.
- No release/packaging step exists yet (Phase 4 concern).
