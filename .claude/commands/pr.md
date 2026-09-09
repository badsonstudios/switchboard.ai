---
description: Push the current branch and open a GitHub PR. Reports what it opened; does not ask first.
---

Open a pull request for the current work. Optional title/body: $ARGUMENTS

1. State what is being pushed (branch, commits) — **do not ask for approval**.
   Typing `/pr` is the approval (changed 2026-09-08, with `/next-item`'s gates).
2. Prefer the helper script:
   ```bash
   .claude/scripts/new-pr.sh -t "<title>" -b "<body>" -B <base-branch>
   ```
   ```powershell
   .\.claude\scripts\new-pr.ps1 -Title "<title>" -Body "<body>" -Base <base-branch>
   ```
   It branches off the base if needed, commits staged changes, pushes, and opens
   the PR via `gh`.
3. Use the default base branch from
   `.claude/skills/startup/references/git-workflow.md` (default `main`).

Report the PR URL when done.
