# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Spike 01 - Foundations (issues #1–#8)
**In progress:** S-02 — Settings injection at spawn (#2) — started 2026-07-19;
probes PASS, review done + fixes applied, awaiting Gate 2 (commit approval)
**Next up:** S-03 — Hook round-trip & decision semantics (#3)
**Branch:** feature/s-02-settings-injection

## Blockers / open questions for Dan

- none

## Log

- 2026-07-19 — **S-01 done** (✅ GO): claude CLI PTY-hosts cleanly in
  Electron + node-pty + xterm.js on Windows; full interactive checklist passed
  with no corruption. Findings: `spike/findings/s-01-pty-host.md` — three
  env/build landmines documented (NoDefaultCurrentDirectoryInExePath, Spectre
  libs, ELECTRON_RUN_AS_NODE). PR #9 (Closes #1):
  https://github.com/badsonstudios/switchboard.ai/pull/9

- 2026-07-18 — Design phase complete: DESIGN.md (29 sections), PHILOSOPHY.md,
  control-room design handoff. Repo created and pushed
  (badsonstudios/switchboard.ai). Plans written (docs/plans/); Spike 01
  milestone + issues S-01..S-08 filed.
- 2026-07-18 — Claude workflow migrated from BrainHarbor and adapted to
  issue-driven flow (skills/agents/hooks/scripts under .claude/).
