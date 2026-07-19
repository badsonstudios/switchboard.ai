# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Spike 01 - Foundations (issues #1–#8)
**AUTOPILOT RUN COMPLETE (2026-07-19)** — Spike 01 finished, S-03→S-08 all ✅
on branch `auto/spike-01-foundations`, draft PR #11 awaiting Dan's review +
merge. **Every mechanism verdict: GO; approval path: HOOK PATH.**
**In progress:** nothing — milestone boundary reached (autopilot stop point)
**Next up:** Dan reviews/merges PR #11 → `/pm file-issues Phase 1`
**Branch:** auto/spike-01-foundations (do not build on it after merge)

## Blockers / open questions for Dan

- **Concurrent DESIGN.md edit detected during autopilot run** (12:29 local,
  new "Cross-provider handoff" subsection after §5's context-transfer part) —
  not written by the autopilot session. Left uncommitted and untouched;
  autopilot commits exclude it. S-08's DESIGN.md open-question updates will
  stage only autopilot hunks. Dan: commit your edit whenever — no conflict
  expected (different sections).

## Log

- 2026-07-19 — **S-08 done** (autopilot; milestone complete):
  `docs/plans/spike-01-findings.md` written; DESIGN.md OQ #2/#5/#10 resolved,
  #3 verdict added, #13 evidence added; Phase 1 plan corrected (scrollback
  5000, settings validation, Notification-as-backup, recursive tailer +
  binding validation, hidden-panes-don't-render). Spike exit criteria all met.
- 2026-07-19 — **S-07 done** (✅ GO, autopilot): 8/12 concurrent sessions —
  idle 7.6%/27.8% of one core, ~420MB/session (CLI-owned), streaming peak 68%,
  UI stall 15ms max (N=12's 939ms = occluded-window timer throttling
  artifact). Findings: `spike/findings/s-07-concurrency-perf.md`
- 2026-07-19 — **S-06 done** (✅ GO, autopilot): hook-only status cycle works;
  Stop ~30ms after turn end; permission Notification debounced ~6s & skippable
  → PreToolUse hold is needs-permission authority. Findings:
  `spike/findings/s-06-status-hooks.md`
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
