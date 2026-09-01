# Git Workflow — switchboard.ai

- **Host:** private GitHub repo `badsonstudios/switchboard.ai`. Tracker:
  GitHub issues, current milestone only (see `docs/plans/00-process.md`).
- **`main` is always-working.** Never commit red to it; never merge red into it.
- **Branch per work item:** `feature/<item-id>-<slug>` (e.g.
  `feature/s-01-pty-host`); `fix/<slug>` for untracked fixes;
  `auto/<milestone>` for autopilot runs (draft PR, Dan merges).
- **Commits:** present-tense, prefixed with the item id (`S-01: …`,
  `P1-E2-03: …`). End with the Claude Code attribution footer.
- **PRs:** title `<item-id>: <title>`; body carries `Closes #<issue>` + a
  summary + test status. **Claude squash-merges once CI is green** —
  `gh pr merge <n> --squash --delete-branch`; then `git checkout main &&
  git pull`. **The gate is green CI, not a human click** (corrected 2026-09-01;
  this line used to say "Dan reviews and squash-merges — never self-merge",
  which parked finished work indefinitely). Reviews are deliberately not
  required on `main`. Red CI does not merge, and `--admin` is not the way past
  a failing check.
- **Definition of done** (00-process.md): done-when criteria met · CI green
  (once CI exists) · lint rules clean · DESIGN.md amended if implementation
  diverged.
- Never stage `.claude/.env` (hook blocks it). Never rewrite pushed history.
