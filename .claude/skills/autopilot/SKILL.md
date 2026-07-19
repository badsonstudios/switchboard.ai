---
name: autopilot
description: Autonomous milestone runner — drive consecutive GitHub-issue work items end-to-end WITHOUT per-item approval gates. Plans, implements, tests, reviews, and commits each item to a single milestone branch with a draft PR that Dan reviews asynchronously. Stops only for [user] items, genuine blockers, or the milestone boundary. Use /next-item instead when Dan is at the keyboard and wants the gates.
user-invocable: true
---

Run a whole milestone (or item range) unattended.

**Argument (optional):** a milestone (`Spike 01`, `Phase 1`), an item range
(`S-01..S-04`), or extra notes — `$ARGUMENTS`. No argument means **the current
milestone in `PROGRESS.md`, from the next open issue to the end of that
milestone**.

## Authority & boundaries

Dan invoked `/autopilot` **specifically to run without interference** — so,
*within this skill only*, the two `/next-item` approval gates are replaced by
the self-checks below. Everything else about the work loop is unchanged.

Hard boundaries that still apply, always:

- **Never merge to `main`.** All work lands on one milestone branch behind a
  draft PR. Dan reviews and merges when he's back. `main` stays always-working.
- **Never commit red.** Build/tests green before every commit — no exceptions.
  (Spike items: the item's done-when criteria met and findings written.)
- **Never touch `.claude/.env`** or put secrets anywhere git-tracked.
- The DESIGN.md hard constraints and PHILOSOPHY.md litmus test are requirements.
- Nothing outward-facing beyond the repo: no releases, no purchases, no
  publishing artifacts publicly. Those are `[user]` territory even if an item
  implies them.

## Setup (once per run)

1. Run `/startup` context load if not already loaded this session; read
   `PROGRESS.md` and `gh issue list --milestone "<target>" --state open`.
2. If the target phase has no issues filed yet, run `/pm file-issues <phase>`
   yourself (the plan file must already exist — if it doesn't, stop and ask;
   expanding a phase plan unattended is out of bounds).
3. Branch: `git checkout -b auto/<milestone-slug>` from up-to-date `main` (or
   switch to it if resuming a prior run).
4. After the first commit, push and open a **draft PR** titled
   `Autopilot: <milestone>` — its description is the live run log; append a
   one-line summary per completed item.
5. Note in `PROGRESS.md` that an autopilot run started (milestone, branch,
   timestamp), and comment on each issue as it's picked up.

## Per-item loop

Follow `/next-item` Steps 1–10 with these substitutions:

- **Gate 1 (plan approval) → self-check.** Validate the plan against the
  issue's done-when criteria, the plan-file spec, and the cited DESIGN.md
  sections. Proceed when they agree. Do **not** proceed when the item is
  ambiguous, under-specified, or contradicts the design docs — and don't
  guess: log it as skipped in `PROGRESS.md` and on the issue (with the
  specific question Dan needs to answer) and move on, unless later items
  depend on it, in which case stop the run.
- **`[user]` items:** skip, log, continue — unless they gate the remaining
  items, in which case stop the run.
- **Gate 2 (commit approval) → commit to the milestone branch.** Message
  `<item-id>: <title>` (body references the issue: `Refs #<n>` — issues close
  when Dan merges, via the PR description's `Closes` lines). Push, update the
  draft PR description, update `PROGRESS.md` (done + one-line outcome). No
  per-item branches or PRs in autopilot mode.
- **Test/review loop:** unchanged (iterate until green + no Blocker/Should-fix
  findings, ~3 rounds). If not converging: revert/stash the broken attempt so
  the branch stays green, record the blocker in `PROGRESS.md` + the issue, and
  move to the next item that doesn't depend on it — or stop if everything does.
- **PROGRESS.md discipline is the resume mechanism.** Update at item start,
  finish, and on any blocker — if this session dies mid-run, a fresh
  `/autopilot` must resume from the file alone.

## Stop conditions (end the run and report)

- Milestone/range complete.
- A blocked or skipped item that the remaining items depend on.
- An action needed that crosses the hard boundaries above.
- Environment breakage (repeated unrelated build failures, claude CLI
  broken/logged out) that a debugger-agent pass can't resolve.

## Final report

When the run ends (complete or stopped), report:

1. Items shipped — one line each.
2. Items skipped/blocked — why, and the exact question or action Dan owes.
3. The draft PR link, and build/test status on the branch tip.
4. Recommended next actions (review + merge PR, answer the open questions,
   `[user]` items to do, then `/autopilot <next>`).

## Notes

- Subagents (Plan, code-reviewer, debugger) inherit the session model — running
  this under Fable means Fable orchestrates and Fable reviews. That's intended.
- This skill is the unattended sibling of `/next-item`: same spec, same
  quality bar, different approval model. If Dan is present and wants gates,
  use `/next-item`.
