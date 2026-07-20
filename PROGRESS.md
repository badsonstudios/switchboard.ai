# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Phase 2 - The Switchboard (issues #37–#41 filed; E7 first)
**In progress:** P2-E7-01 — Live usage & cost on the card (#37)
**Next up:** P2-E7-02 — Git context line (#38)
**Branch:** auto/phase-2-switchboard (to be created)

## Phase status

- **Spike 01 — DONE** (all mechanisms GO; merged).
- **Phase 1 — MVP — DONE & MERGED** (PR #36 → main, 2026-07-20): full app —
  session core, hooks, transcripts, git, notifications, persistence +
  resume-on-focus, auto-trust. CI green 3 OSes. Milestone closed.
- **Phase 2 — The Switchboard — STARTING.** Plan:
  `docs/plans/04-phase-2-switchboard.md`. Leading with E7 (richer cards) —
  owner's expressed interest + fast win on data we already collect.

## Blockers / open questions for Dan

- **[user] "Red build blocks merge" (#13) still procedural** — branch
  protection/rulesets are plan-gated on free private repos. CI is live + green;
  the merge gate is manual (I verify CI before merging). Upgrade to Pro / make
  public to enforce server-side.
- **Loose ends deferred** (not blocking): full-auto → bypass footgun (offer:
  remap to a safer mode), 9MB Monaco renderer bundle (slim it). Say the word.

## Log

- 2026-07-20 — **Phase 1 MERGED to main** (PR #36, CI green 3 OSes; milestone
  closed). Post-MVP dogfooding fixes landed in the same PR: quit-on-close,
  ghost-card pruning, IPC hardening, stuck-"working" status (keystroke-revives-
  done bug, root-caused from the app log), dead-card dismiss/restart,
  auto-trust folders, and session persistence + resume-on-focus. **Phase 2
  planned** (`04-phase-2-switchboard.md`); milestone + E7 issues (#37–41) filed.
- 2026-07-19 — Phase 1 built end-to-end on autopilot (E1–E6, #12–#35): scaffold/
  CI/theme/i18n/logging/registry; PtyService, Claude adapter, SessionManager,
  workspace store, HookListener, TranscriptWatcher; Dockview shell, terminals,
  identity, new-session flows, rail; event feed + notifications; GitService +
  Monaco diff; autonomy/quit-protection/preflight. Two epic-review passes.
- 2026-07-19 — **Spike 01 DONE** (all GO; PR #10, merged). PTY hosting,
  settings injection, hook round-trips (HOOK PATH), transcript tailing,
  sidechain visibility, hook-driven status, 12-session concurrency all proven;
  verdicts written into DESIGN.md; findings in `spike/findings/`.
