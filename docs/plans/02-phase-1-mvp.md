# Phase 1 — Kill the Five Windows (MVP)

> **Milestone:** `Phase 1 - MVP` (issues #12–#35, filed 2026-07-19).

**Goal:** one window replaces the owner's five VS Code windows for daily work.
Sessions in arbitrary folders, real terminals, status at a glance, notified when
needed, basic diffs. Daily-driver usable at the end of this phase — by the
owner, on Windows.

**Prerequisite:** Spike 01 exited; items below assume its verdicts (approval
path, transcript patterns, perf mitigations) and inherit corrections from
`spike-01-findings.md`.

**Epics:** E1 Scaffold & day-one architecture · E2 Session core · E3 UI shell ·
E4 Events, status & notifications · E5 Git pane · E6 Lifecycle & autonomy

---

## E1 — Scaffold & day-one architecture

- **P1-E1-01 · Electron scaffold — M.** electron-vite + TypeScript + React;
  main/renderer/preload structure; window state persistence.
  *Done when:* app opens/closes cleanly on Windows; mac/linux builds compile in CI.
- **P1-E1-02 · CI pipeline — S.** GitHub Actions: lint + typecheck + build on
  all three OSes on every PR.
  *Done when:* a red build blocks merge.
- **P1-E1-03 · Theme token system — M (§5.20).** Semantic base + component
  tokens as CSS custom properties; dark + light maps (seed from
  design_handoff_control_room palettes); OS sync; lint rule banning raw colors.
  *Done when:* theme flips live; lint fails a hardcoded hex in a component.
- **P1-E1-04 · i18n foundation — S (§5.21).** i18next + ICU; en.json; lint rule
  banning hardcoded UI strings; logical CSS properties convention; pseudo-locale
  dev toggle.
  *Done when:* pseudo-locale renders every UI string mangled (proving none are
  hardcoded).
- **P1-E1-05 · Logging pipeline — M (§5.22).** JSON-lines, rotating files,
  subsystem + sessionId fields, redaction layer in the logger, per-subsystem
  debug toggles.
  *Done when:* a token passed through log args comes out redacted; one filtered
  grep reconstructs a session's lifecycle.
- **P1-E1-06 · Extensibility seams v0 — M (§5.23).** Contribution-point +
  capability-manifest TypeScript schema; internal registry; Claude adapter and
  event feed registered through it (in-process).
  *Done when:* the Claude adapter is loaded via the registry, not imported
  directly by the session manager.

## E2 — Session core

- **P1-E2-01 · PtyService — M.** node-pty wrapper (ConPTY/forkpty), spawn with
  cwd/env (scrub `ELECTRON_RUN_AS_NODE`, resolve CLI to absolute path — S-01),
  resize, kill, exit codes, scrollback cap **5000** (S-07 verdict).
  *Done when:* spawn→resize→kill lifecycle is clean across 12 concurrent PTYs.
- **P1-E2-02 · Claude Code adapter v1 — M.** Spawn via provider interface;
  settings injection per S-02 verdict (generated per-session file, absolute
  path, validate JSON before spawn — invalid files are silently ignored; hook
  commands in POSIX sh); env prep; resume args support.
  *Done when:* a session spawns in any chosen folder and `--resume` restores it.
- **P1-E2-03 · SessionManager — M.** Create/kill/restart sessions; session
  registry with identity fields; state machine (working/needs-input/idle/done/
  crashed) fed by hook events.
  *Done when:* state transitions are observable (logged + queryable) through a
  real work cycle. Depends: E2-01, E2-02.
- **P1-E2-04 · Workspace store — M.** Persist sessions (folder, identity,
  layout slot, window geometry w/ display fingerprint §7) + restore on launch:
  suspended cards, resume-on-focus (§5.25).
  *Done when:* quit → relaunch reproduces the workspace exactly; a saved
  position on a missing display rescues into the main window.
- **P1-E2-05 · HookListener — M (§5.29 floor).** Loopback bind, per-session
  tokens (NOT on argv — env or ACL'd file, S-03 note), Host allowlist;
  Notification/Stop/SubagentStop → session state machine (S-06: Stop ~30ms;
  Notification is a ~6s-debounced backup that never fires on fast answers —
  needs-permission clears on the next hook event, none fires on acceptance);
  short `timeout` on status hooks; PreToolUse pass-through (approval UI is
  Phase 2 — Phase 1 leaves the TUI prompt in charge).
  *Done when:* status badges flip from hook events alone; a request without a
  valid token is rejected and logged.
- **P1-E2-06 · TranscriptWatcher — M.** Tolerant tailer per S-04/S-05
  patterns: recursive scan (nested `subagents/` files + meta.json), session
  binding via new-file detection validated against `cwd`/`sessionId` (race is
  real), transcript may not exist until first prompt; usage totals +
  last-activity per session.
  *Done when:* per-session token counts update live and malformed lines never
  crash the watcher.

## E3 — UI shell

- **P1-E3-01 · Main window layout — M.** Title bar, sessions rail, grid, status
  bar (per design handoff); Dockview integration for the grid.
  *Done when:* 1–8 session cards lay out in the grid, resizable, layout persists.
- **P1-E3-02 · Terminal pane — M.** xterm.js in each card wired to PtyService;
  focus management; hidden panes per S-07 verdict: don't render at all —
  ring-buffer PTY bytes, attach xterm on focus.
  *Done when:* typing latency feels native with 8 sessions open (S7).
- **P1-E3-03 · Session identity v1 — S (§5.11).** Title (folder-name default,
  editable), auto accent color, project-type icon; rendered identically in rail
  + card header.
  *Done when:* seven sessions are tell-apart-able in under a second (S2 check).
- **P1-E3-04 · New-session flows — S.** ⊕ dialog (folder picker + name/color)
  AND drag-a-folder-onto-window.
  *Done when:* folder-drop → running session in ≤3 seconds (P1 check).
- **P1-E3-05 · Sessions rail v1 — S.** Rows with identity + live status badge;
  click focuses the session (S1: ≤2 gestures).
  *Done when:* rail reflects state machine live. Depends: E2-03, E3-03.

## E4 — Events, status & notifications

- **P1-E4-01 · Event feed v1 — M (§5.12).** Internal event stream (the log's
  user-facing projection); feed panel: done / needs-input / needs-permission /
  crash, click-to-focus, session color stripes.
  *Done when:* a full work cycle across 3 sessions reads coherently in the feed.
- **P1-E4-02 · Notifications v1 — S (§5.9).** Sound + window flash + OS toast
  on needs-input / needs-permission / done; global toggle + quiet hours.
  *Done when:* owner hears/sees a needs-permission event from another app within
  2 seconds of the hook firing.

## E5 — Git pane

- **P1-E5-01 · GitService — M.** Status + diff via system git; parsed models;
  per-session repo detection.
  *Done when:* status and per-file diffs are queryable for any session folder
  that is a repo (graceful when it isn't).
- **P1-E5-02 · Diff viewer pane — S.** Monaco diff (read-only), file list with
  VCS badges, per-session tab.
  *Done when:* reviewing another session's changes requires no external editor.

## E6 — Lifecycle & autonomy

- **P1-E6-01 · Autonomy profiles at spawn — S (§5.9).** Slider (Plan / Ask /
  Auto-edit / Full-auto) → permission-mode + allowed-tools flags.
  *Done when:* profile choice observably changes prompting behavior.
- **P1-E6-02 · Quit protection — S (§5.25).** Quit with working sessions →
  confirmation listing who's mid-task.
  *Done when:* accidental quit with 3 working agents is a two-step act.
- **P1-E6-03 · First-run preflight — S (§5.25).** Detect claude CLI presence /
  version / login; guided fix screens; re-check per spawn.
  *Done when:* a machine without the CLI gets instructions, not a stack trace.

---

## Exit criteria (Phase 1 ships when)
1. Owner runs 5+ real sessions in one window for a full working day, by choice.
2. Every notification pain from the VS Code workflow is covered (status glance,
   needs-input alert, done alert).
3. CI green on all three OSes; Windows is the proven daily driver.
4. Litmus check passes on everything shipped (PHILOSOPHY.md §4).

## Suggested order
E1 first (everything builds on it) → E2-01/02/03 → E3-01/02 (first visible
session!) → remaining E2 + E3 in parallel → E4 → E5/E6 in any order.
