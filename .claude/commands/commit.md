---
description: Stage (if needed) and commit the current changes. Reports what it committed; does not ask first.
---

Commit the current work. An optional commit message may follow: $ARGUMENTS

1. Show `git status` and a summary of `git diff` so the user sees what was committed.
2. **Do not ask for approval** — typing `/commit` is the approval (changed
   2026-09-08, with `/next-item`'s gates). Say what you are staging, then stage
   it. The one thing that still stops you: a diff containing changes you cannot
   explain as part of this work — say so instead of sweeping them in.
3. Stage the intended files and commit with a clear, present-tense message.
   Reference issues with `Fix #<n>:` / `Closes #<n>:` when applicable. Follow
   `.claude/skills/startup/references/git-workflow.md`.

Never stage `.env` or other secrets (a hook will block it anyway). For pushing and
opening a PR, use `/pr`.
