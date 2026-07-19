# Spike 01 — Findings Report

**Date:** 2026-07-19 · **CLI:** Claude Code 2.1.215 · **OS:** Windows 11
native · **Harness:** Electron 43 + node-pty 1.1.0 + xterm.js 6 (`spike/`)

**Bottom line: every load-bearing mechanism is GO.** PTY hosting, settings
injection, hook round-trips (the gate), transcript tailing, sidechain
visibility, hook-driven status, and 12-session concurrency all work on the
real stack on Windows. Phase 1 is assembly, not research. Detailed notes per
item live in `spike/findings/`; committed evidence in
`spike/findings/artifacts/`.

## Go/no-go per mechanism

| Mechanism | Verdict | One-line evidence |
|---|---|---|
| S-01 PTY-host the real CLI | **GO** | Full interactive session, zero corruption; 84–96ms first byte |
| S-02 Settings injection (`--settings`) | **GO** | Hooks fire, additive merge with user settings, project `.claude/` untouched |
| S-03 Hook round-trip approvals | **GO — HOOK PATH** | All decision-matrix cells observed; deny carries message; clean TUI fallback on timeout |
| S-04 Transcript discovery + tailing | **GO** | Discovery ~4s, lag median 268ms, tolerant reader proven |
| S-05 Sidechain visibility | **GO** | Nested per-agent files + meta.json identity; ~160ms lag; plan-chip viable |
| S-06 Hook-driven status | **GO** | Full cycle hook-only; Stop within ~30ms; Notification debounce ~6s characterized |
| S-07 12-session concurrency | **GO** | Idle ~28% of one core; ~420MB/session (CLI-owned); 15ms max UI stall |

## Spike exit criteria

1. **OQ verdicts in DESIGN.md** — done: OQ #2 resolved, #3 verdict added
   (mechanism GO, drift posture stands), #5 resolved, #10 resolved (HOOK
   PATH), #13 evidence added.
2. **Approval-path decision** — **HOOK PATH**, with keystroke fallback held in
   reserve (only route to the TUI's own session-scoped "allow all edits").
3. **Perf numbers for 12 sessions** — recorded (`artifacts/s07/`).
4. **Phase 1 plan reviewed** — corrections applied to `02-phase-1-mvp.md`
   (see below).

## Cross-cutting discoveries Phase 1 must absorb

- **Version volatility is real and fast.** In one CLI version we caught:
  Task→`Agent` tool rename, trust-dialog wording change ("Accessing
  workspace"), subagent transcripts moved to nested files, ~600s (not 60s)
  default hook timeout. Every integration point needs the §5.26 tolerant
  posture plus a per-release re-verify pass (the spike probe scripts are
  rerunnable for exactly this).
- **Fail-open holds everywhere it was tested**: dead listener → instant CLI
  default behavior; hung listener → TUI fallback at hook-timeout expiry;
  malformed transcripts → counted, not crashed. Set short `timeout` on status
  hooks, long on approval hooks.
- **Status authority split confirmed**: hooks for transitions (Stop ~30ms),
  transcript for telemetry (no done-marker in transcript; permission
  Notification debounced ~6s and skippable — switchboard's own PreToolUse
  hold is the real needs-permission signal).
- **Windows specifics**: hook commands run under Git Bash (POSIX sh is safe);
  `ELECTRON_RUN_AS_NODE` leak and env hygiene per S-01; per-session settings
  token should not ride argv in the product (§5.29 note).
- **Capacity fact**: ~420MB working set per idle claude session — surface it
  in the UI; it's the CLI's, not ours to fix.

## Corrections applied to the Phase 1 plan

1. P1-E2-01: scrollback cap verdict = **5000** (held under streaming).
2. P1-E2-02: settings injection = generated per-session file, absolute path,
   validate JSON before spawn (silent-ignore risk).
3. P1-E2-05: Notification is a debounced (~6s) backup signal — the state
   machine treats PreToolUse-hold/round-trip as needs-permission authority;
   no event fires on prompt acceptance (clear on next hook event).
4. P1-E2-06: tailer must scan recursively (nested subagent files), bind
   sessions by new-file detection + `cwd`/`sessionId` validation (race is
   real), and tolerate transcript-appears-on-first-prompt.
5. P1-E3-02: "hidden-pane render throttling" → **hidden panes don't render**:
   ring-buffer PTY bytes, attach xterm on focus only.
