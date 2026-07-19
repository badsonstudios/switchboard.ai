# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Spike 01 - Foundations (issues #1–#8)
**AUTOPILOT RUN ACTIVE** — started 2026-07-19, milestone Spike 01 (S-03→S-08),
branch `auto/spike-01-foundations`, draft PR opens after first commit. Dan
approved S-07's concurrent sessions. Run stops at milestone boundary.
**In progress:** S-06 — Notification/Stop hooks → status events (#6)
**Next up:** S-07 — Concurrency & perf probe (#7)
**Branch:** auto/spike-01-foundations

## Blockers / open questions for Dan

- **Concurrent DESIGN.md edit detected during autopilot run** (12:29 local,
  new "Cross-provider handoff" subsection after §5's context-transfer part) —
  not written by the autopilot session. Left uncommitted and untouched;
  autopilot commits exclude it. S-08's DESIGN.md open-question updates will
  stage only autopilot hunks. Dan: commit your edit whenever — no conflict
  expected (different sections).

## Log

- 2026-07-19 — **S-05 done** (✅ GO, autopilot): subagent transcripts are
  nested per-agent files (`<session>/subagents/agent-<id>.jsonl` + meta.json
  with agentType/description/toolUseId); live tail lag ~160ms; TodoWrite
  plan-state extraction viable (OQ #13). Findings:
  `spike/findings/s-05-sidechain-visibility.md`
- 2026-07-19 — **S-04 done** (✅ GO, autopilot): transcript discovered 3.9s
  after spawn (slug mapping confirmed for :/ chars; new-file detection is the
  real binding), tail lag 24–815ms (median 268ms), tolerant reader survives
  garbage/unknown types, tokens/tools/files extractable. No terminal "done"
  marker in transcript → hooks are status authority. Findings:
  `spike/findings/s-04-transcript-tailing.md`
- 2026-07-19 — **S-03 done** (✅ HOOK PATH, autopilot): full decision matrix
  observed headless + interactive TUI. allow overrides default-deny; deny
  carries reason verbatim to model; ask surfaces real TUI prompt; hook hang →
  clean TUI fallback after ~600s default budget (config via timeout field —
  90s hold verified); dead listener fails open instantly. §5.29 floor
  verified (401/403). Findings: `spike/findings/s-03-hook-roundtrip.md`
- 2026-07-19 — Autopilot run started: milestone Spike 01 (S-03→S-08), branch
  `auto/spike-01-foundations`.

- 2026-07-19 — **S-02 done** (✅ GO): `claude --settings <abs-file-path>` at
  spawn is the Phase 1 hook-injection mechanism — hooks fire, user settings
  compose additively, project `.claude/` untouched (sha1-verified); hook
  commands run under Git Bash on Windows. Findings:
  `spike/findings/s-02-settings-injection.md`. PR #10 (Closes #2, merged):
  https://github.com/badsonstudios/switchboard.ai/pull/10

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
