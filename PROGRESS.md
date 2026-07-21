# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Phase 2 - The Switchboard (issues #37–#41 filed; E7 first)
**In progress:** E8 popout foundation built (#43) — BLOCKED on Dan verifying the
popout actually opens before I build E8-02/03 on top of it
**Next up:** Dan tests ⬏ pop-out; then P2-E8-02 geometry persistence (#44)
**Branch:** auto/phase-2-switchboard (draft PR #42)

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

- 2026-07-20 — **E8 spike + foundation (#43)**: dockview 7 has a first-class
  popout API. Wired the Electron integration — built popout.html entry, a
  NARROW window-open allowance scoped to our own same-origin popout.html
  (everything else still denied, §5.29 intact), and a ⬏ control on each card
  calling addPopoutGroup. Builds + boots clean; 101 tests. E8-02/03 issues
  filed (#44/#45). **BLOCKING [Dan eyeball]: click ⬏ on a card — does it open
  in its own OS window with the terminal still working under sandbox+CSP?**
  Not building E8-02/03 until this is confirmed (it's the design's flagged
  risk).
- 2026-07-20 — **E7 epic COMPLETE** (richer cards): E7-01 live usage/cost,
  E7-02 git context line, E7-03 autonomy badge + editable task label (fixed a
  chip regression), E7-04 plan-as-progress chip (TodoWrite extraction), E7-05
  suspended cards in the rail (card-keyed sessions:cards view). Epic review:
  0 blockers; fixed usage-aggregate double-count on resume, rail-rename/task-
  label shadowing, model-clobber-on-resume, IPC input guards, plan-chip clear.
  101 unit tests green. **[Dan eyeball]: the card header (usage/git/plan/badge/
  task label) and suspended rail rows on a real multi-session workspace.**
- 2026-07-20 — **P2-E7-01 done**: live usage & cost on the card. Transcript
  watcher now captures model; a usage strip on each card shows tokens
  (↑in ↓out ⛁cache) + an est. cost (labeled — subscription-first, public
  per-model rates, sonnet default); status bar shows the workspace total.
  Usage persists per card and seeds on create so it survives resume/restart.
  Data pipeline verified (check:transcripts still emits usage after the model
  change; 100 unit tests incl. usage math). **[Dan eyeball]: watch the numbers
  tick up on a live session.**
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
