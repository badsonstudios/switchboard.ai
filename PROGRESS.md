# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Phase 2 - The Switchboard (issues #37–#45 filed; E7 + E8 DONE)
**In progress:** nothing — all filed Phase 2 issues (E7 richer cards, E8
pop-out) are implemented + tested on the branch, awaiting Dan's review/merge.
**Next up (needs Dan):** review/merge draft PR #42, then decide whether to
expand the E9/E10/E11 outlines into full work items (a `/pm plan` + `/pm
file-issues` step — expanding a phase plan is not done unattended).
**Branch:** auto/phase-2-switchboard (draft PR #42)

## Testing (3 layers — see skills/startup/references/testing.md)
`npm test` (unit) · `npm run check:*` (local real-claude proofs) · `npm run e2e`
(Playwright drives the real window headlessly; fake provider = shell-in-a-PTY,
temp-home isolated, CI-safe). **New user-facing surface ⇒ add an e2e test, not
a "[Dan eyeball]" note.**

## Phase status

- **Spike 01 — DONE** (all mechanisms GO; merged).
- **Phase 1 — MVP — DONE & MERGED** (PR #36 → main, 2026-07-20): full app —
  session core, hooks, transcripts, git, notifications, persistence +
  resume-on-focus, auto-trust. CI green 3 OSes. Milestone closed.
- **Phase 2 — The Switchboard — E7 + E8 DONE (on branch, PR #42).** Plan:
  `docs/plans/04-phase-2-switchboard.md`. E7 (richer cards) + E8 (pop-out:
  foundation, geometry persistence, rejoin/lifecycle) complete + e2e-tested.
  E9 (attention-driven layout), E10, E11 remain as OUTLINES — not yet expanded
  into work items or filed as issues (just-in-time; needs `/pm plan`).

## Blockers / open questions for Dan

- **[user] "Red build blocks merge" (#13) still procedural** — branch
  protection/rulesets are plan-gated on free private repos. CI is live + green;
  the merge gate is manual (I verify CI before merging). Upgrade to Pro / make
  public to enforce server-side.
- **Loose ends deferred** (not blocking): full-auto → bypass footgun (offer:
  remap to a safer mode), 9MB Monaco renderer bundle (slim it). Say the word.

## Log

- 2026-07-21 — **E8 epic COMPLETE (#43–#45)**: pop-out foundation (E8-01,
  loopback-http fix), geometry persistence (E8-02: `sanitizePopoutLayout`
  rewrites the stored popout url to the current loopback port + rescues
  off-display positions; app:workAreas IPC; e2e relaunch test), and
  rejoin/lifecycle (E8-03: closing a popped-out window docks the session back
  and never kills it — DESIGN.md subwindow model — verified to already hold via
  the S-07 re-attach model, no new lifecycle code; e2e types into the
  docked-back terminal to prove survival). Corrected the plan's E8-03 wording
  that had contradicted DESIGN.md. 106 unit + 10 e2e green. **Phase 2's filed
  scope (E7+E8) is now complete on the branch.**
- 2026-07-21 — **Playwright-Electron e2e testing added** (Dan's ask: "fully
  test the UI without me"). Harness `e2e/fixtures/app.ts` launches the built
  app fully isolated (temp HOME, never touches real ~/.claude.json/workspace)
  with a FAKE PROVIDER (shell-in-a-PTY, no claude login → CI-safe). 8 e2e tests:
  boot + loopback-http, theme toggle, pseudo-locale, autonomy cycle, session
  spawns a live terminal (type a command → see output), **pop-out opens a 2nd
  OS window (E8-01 now verified by test, not eyeball)**, rail lists the session.
  npm scripts (e2e / e2e:only / e2e:headed / e2e:ui), CI e2e job (Windows +
  Linux/xvfb), testing.md rewritten (3 layers). 101 unit + 8 e2e green.
- 2026-07-21 — **E8-01 popout WORKS (#43)**: Dan reported ⬏ did nothing.
  Instrumented (renderer-console→log, window-open logging, auto-popout seam)
  and root-caused from the app's own log: `dockview: popout URL must be
  same-origin http(s); got file://…`. dockview flatly refuses file://.
  Fix: a loopback static server serves the packaged renderer over
  http://127.0.0.1:<port> (was loadFile/file://); popout URL + will-navigate +
  window-open allowance now key off that origin. Verified via log:
  window-open(popout:true) → onDidAddPopoutGroup → result:true. Diagnostic
  seam removed; renderer-console-forwarding kept. 101 tests, clean boot over
  http. **[Dan eyeball]: click ⬏ — a window should tear off with the terminal
  live.** E8-02/03 build once confirmed.
- 2026-07-20 — **E8 spike + foundation (#43)**: dockview 7 has a first-class
  popout API; wired popout.html entry + narrow window-open allowance + ⬏
  control. (file:// blocker found next session.)
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
