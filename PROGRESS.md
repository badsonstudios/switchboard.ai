# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Phase 2 - The Switchboard (E7+E8 merged; E12 expanded + filed
#49–#57, E8-06 filed #48; E9/E10/E11/E13/E14 still outlines)
**In progress:** nothing mid-flight — AUTOPILOT RUN (E10) COMPLETE
2026-07-21: all 6 items (#59–#64) shipped to `auto/phase-2-e10`, draft
PR #65. 137 unit + 27 e2e green; CI pending on the tip.
**Next up (needs Dan):** review/merge draft PR #65. Eyeball: one real
claude turn fully in the Session tab (composer → rich blocks → inline
approval), plus the E12 grid-drag re-check he skipped. Then `/pm plan`
for the next epic (E9 attention-layout or E11 session bus).
**Branch:** auto/phase-2-e10 (draft PR #65)

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
- **Phase 2 — The Switchboard — E7 + E8 MERGED to main** (PR #42 squash-merged
  2026-07-21, CI green 5 jobs; issues #37–#47 closed). Plan:
  `docs/plans/04-phase-2-switchboard.md` (reconciled vs DESIGN.md §8
  2026-07-21 — see log). P2-E8-06 (reconnect offer) added later, not yet
  filed. E9–E14 remain as OUTLINES — not yet expanded into work items or
  filed as issues (just-in-time; needs `/pm plan`).

## Blockers / open questions for Dan

- **[user] GitHub Actions billing is broken** (found 2026-07-21 on PR #65's
  CI run): every job dies in 3s with "recent account payments have failed or
  your spending limit needs to be increased" — fix in GitHub Settings →
  Billing & plans, then re-run the PR #65 checks. Local gate was fully green
  (lint + typecheck + 137 unit + 27 e2e, Windows).

- **[user] "Red build blocks merge" (#13) still procedural** — branch
  protection/rulesets are plan-gated on free private repos. CI is live + green;
  the merge gate is manual (I verify CI before merging). Upgrade to Pro / make
  public to enforce server-side.
- **Loose ends deferred** (not blocking): full-auto → bypass footgun (offer:
  remap to a safer mode), 9MB Monaco renderer bundle (slim it). Say the word.
- **[user] ClaudeMon architecture read (OQ #8) is due.** `03-later-phases.md`
  says it must happen before Phase 3 planning, "ideally far earlier" — and the
  2026-07-21 reconciliation just moved MORE into Phase 3. Schedule a session
  to review ClaudeMon and decide shared-library vs sidecar vs merge.

## Log

- 2026-07-21 — **P2-E10-06 done (#64)**: rich tool blocks v2 (the extension
  reference). Watcher: Edit/Write blocks carry structured filePath/old/new,
  Bash carries its description + tool_result OUT attaches by tool_use_id
  (block re-emitted, renderer upserts by seq), thinking gets durationMs when
  the next block lands, TodoWrite emits a checklist block. Renderer: timeline
  dot gutter; EditBlock (+N/-M subtitle, red/green panes, click-collapse);
  BashBlock (description header, independent IN/OUT expanders); TodosBlock;
  "Thought for Ns". e2e: synthetic transcript drives all block types.
  137 unit + 27 e2e green. **E10 epic complete on the branch.**
- 2026-07-21 — **P2-E10-05 done (#63)**: composer options row — autonomy
  chip (click cycles; persists via new sessions:setAutonomy to the card
  record, applies on next spawn/resume since the CLI can't switch live),
  model indicator (last transcript-seen model), working pulse dot. e2e:
  chip cycles + survives relaunch.
- 2026-07-21 — **P2-E10-04 done (#62)**: inline approval bar. A held
  PreToolUse flips a review bar up in the Session tab: "Allow <tool>?",
  primary-arg line, old/new edit preview (diff-token shading) or command
  preview, Allow / Allow-all-this-session / Deny. Allow-all auto-answers
  later requests for that card (renderer memory — resets on restart, the
  safe default). Bar auto-dismisses on main-side timeout via
  sessions:permissionResolved. OS toast for needs-permission is now quiet
  when the window is focused (other kinds still toast). e2e drives the REAL
  listener: log-scraped port + real session token → PreToolUse POST → bar →
  verdict JSON asserted (allow, allow-all auto-allow, deny). 136 unit + 26
  e2e green.
- 2026-07-21 — **P2-E10-03 done (#61)**: PreToolUse hold + decision
  round-trip. HookListener parks a gated PreToolUse response until
  decide(allow/deny) returns the hook verdict JSON (permissionDecision via
  hookSpecificOutput); timeout (60s) and every teardown path fail OPEN to
  '{}' → the CLI's own TUI prompt. Hold policy = shouldHoldPermission
  (autonomy-aware: ask/plan gate Bash/Write/Edit/NotebookEdit/WebFetch,
  auto-edit gates Bash/WebFetch, full-auto never, unknown never). Forwarder
  now relays the response body to stdout (verdict channel) with a per-event
  wait budget; PreToolUse hook entry gets its own long timeout. State
  machine's pre-built permission-held/resolved events now fire for real.
  IPC: sessions:permissionRequest stream + sessions:decidePermission.
  6 new unit tests (hold/deny/timeout/ungated/unregister/policy).
  136 unit + 24 e2e green.
- 2026-07-21 — **P2-E10-02 done (#60)**: prompt composer v1 in the Session
  view — bottom-docked textarea (Enter sends, Shift+Enter newline, auto-grow,
  ↑ send button), writes the prompt to the live PTY (multiline as one
  bracketed paste; escape bytes built from charCodes). e2e: composer →
  PTY → real shell output. The composer is an input ROUTE (§5.10 guardrail).
- 2026-07-21 — **P2-E10-01 done (#59)**: view tab renamed Feed → **Session**;
  **Terminal out of the default strip** — ⋯ menu (now a real menu) shows/
  hides it per session (persisted in the ui blob; stored Terminal tab only
  restores when shown), chip surfaces it on demand and is re-labeled
  "continue in Terminal ↗"; TerminalPane mounts only when shown (S-07 ring
  buffer replays scrollback on late mount). e2e: default strip has no
  Terminal, menu round-trip, shown-state survives relaunch.

- 2026-07-21 — **Session-view visual spec pinned (Dan's VS Code-extension
  screenshot).** DESIGN.md §5.10 gains "Block presentation (v2)": timeline
  dot gutter, Edit blocks w/ header + added/removed subtitle + inline
  highlighted diff, Bash blocks w/ description header + expandable IN/OUT,
  "Thought for Ns" thinking, TodoWrite as checklist. **Terminal demoted
  again: hidden by default** — out of the strip, shown via ⋯ menu/toggle or
  the continue-in-Terminal chip, state persisted. E10-01 rescoped (#59
  updated), new **P2-E10-06 Rich tool blocks v2** filed (#64).
- 2026-07-21 — **Session-tab pivot decided (Dan) + E10 expanded & filed.**
  From hands-on testing: the rendered view must be the primary WORKING
  surface (VS Code-extension shape — conversation + prompt composer + inline
  approvals), not a read-only feed; tab renamed **Session**. DESIGN.md §5.10
  amended (composer/approvals = input routes to the real CLI; Terminal =
  escape hatch; host-don't-reimplement intact). E10 retitled "Session tab &
  Approval surfaces v1", jumped ahead of E9 (the plan's own TUI-pain
  clause), expanded to P2-E10-01…05, issues #59–#63 filed. Builds after
  PR #58 merges.
- 2026-07-21 — **Dan's eyeball fixes (PR #58)**: (1) every dockview tab now
  has a ✕ — closes the tab; for a session card that ends the session and
  forgets the record (e2e added); diff tabs close too. (2) Grid tab → rail
  group-header drags now work: dockview drags don't carry our dataTransfer
  type, so onWillDragPanel publishes the in-flight card via lib/drag-context
  and the rail headers read it (**[Dan eyeball]** re-check the drag). Items
  4–5 of his feedback (Feed → primary interactive tab with composer +
  in-app approvals) are a DESIGN-level change — proposal drafted, awaiting
  his call before amending DESIGN.md/plan.

- 2026-07-21 — **CI red on the run's tip → fixed.** Two roots: (1) local gate
  had skipped `npm run typecheck` (electron-vite build ≠ tsc) — 6 TS errors
  (uiGet literal-type inference ×5, onDidActivePanelChange event shape);
  testing.md now pins the full local gate. (2) Linux e2e leaked one shared
  profile across ALL tests: Electron resolves userData via XDG on Linux and
  the fixture only overrode HOME — XDG_CONFIG/CACHE/DATA_HOME now isolated
  (pre-existing hole; E12's fresh-profile assertions exposed it). Full gate
  green locally incl. typecheck; **CI GREEN on 76ffdb8** (unit ×3 OS + e2e
  Windows/Linux).

- 2026-07-21 — **P2-E8-06 done (#48)**: display reconnect offer. Rescued
  popouts (position nulled by the E8-02 sanitize) are stashed in the ui blob
  with their original box + panel ids; `display-added` → renderer checks the
  stash → the event feed shows a one-click "restore layout?" offer — never
  automatic. Accept moves the still-open popout back via a main-process
  `app:movePopout` (DOM moveTo clamps to known screens) or re-pops a docked
  card at the stashed position; "Not now" changes nothing, stash kept.
  e2e drives rescue → offer → decline → accept (CI can't hotplug a real
  monitor, so the final placement asserts the move + stash-consumed;
  **[Dan eyeball]** exact placement when re-docking at the desk).
  130 unit + 22 e2e green. **All filed E12 + E8-06 scope complete.**
- 2026-07-21 — **P2-E12-08 done (#56)**: focus-state persistence via a new
  renderer-owned `ui` blob in the workspace store (workspace:getUi/setUi).
  Persists focused card + per-card active view-tab; restore refocuses the
  card (resume-on-focus then revives it first) and reopens its tab. **Found
  & fixed en route:** localStorage resets EVERY packaged launch (loopback
  origin gets a random port), so the Phase-1 autonomy chip never actually
  persisted in production — autonomy, feed verbosity, and rail collapse all
  migrated to the ui blob (one-time localStorage migration kept for dev).
  e2e: view-tab + autonomy survive relaunch. 130 unit + 21 e2e.
- 2026-07-21 — **P2-E12-09 done (#57)**: view-tab strip aligned to the §5.10
  canonical set — Diff renamed **Changes**, the Files "soon" placeholder is
  now **History** (soon). Strip reads Feed · Terminal · Changes · History.
- 2026-07-21 — **P2-E12-07 done (#55)**: Feed verbosity presets
  (quiet/normal/firehose; pure blockVisible rule, per-card persisted,
  live-switchable), "waiting in Terminal ↗" chip on needs-input/permission
  that jumps to the Terminal tab, and **Feed is now the default view**
  (§5.10). e2e updated for the flip + preset switching; the waiting chip is
  a status-driven conditional (fake provider can't emit hook statuses —
  covered by the status pill's existing path; **[Dan eyeball]** chip on a
  real permission prompt). 129 unit + 19 e2e.
- 2026-07-21 — **P2-E12-06 done (#54)**: Feed view v1. TranscriptWatcher
  derives FeedBlocks (user/assistant/thinking/tool; sidechain-flagged; capped
  backlog) from the lines it already parses; new `transcripts:blocks` +
  `sessions:feedBlock` IPC; FeedView renders markdown (marked+DOMPurify,
  sanitized), collapsed tool rows, folded thinking, indented sidechains,
  tail-pinned scroll, strictly read-only. Feed tab is now live (Terminal
  still default until E12-07). Also fixed 10 lint errors from E12-02/03
  (palette hexes moved to main as groups:palette data; ⊕/✕ via i18n) —
  two pushed commits were lint-red on CI; branch tip is green again.
  126 unit + 19 e2e.
- 2026-07-21 — **P2-E12-05 done (#53)**: repo/folder auto-grouping. Main
  computes a per-card autoKey (git toplevel, else normalized folder; cached);
  rail clusters ungrouped sessions sharing a key into an italic dashed-dot
  emergent section (computeAutoGroups, unit-tested: singletons never group,
  S4 explicit-wins, vanish-when-emptied). e2e: 2 same-folder sessions
  auto-group; dragging one into a real group dissolves it.
- 2026-07-21 — **P2-E12-04 done (#52)**: move-between-groups. Rail rows are
  draggable — drop on a group header joins it (panel moves next to its
  siblings), drop on the rail background ungroups; grid drags adopt the new
  dockview-group's persistent group (pickAdoptedGroupId, unit-tested;
  restore-replay guarded). e2e drags in+out via synthesized DataTransfer and
  relaunches. Note: the dockview-native grid drag itself isn't e2e-drivable
  headlessly — covered by the unit rule + wiring; **[Dan eyeball]** one real
  grid drag.
- 2026-07-21 — **P2-E12-03 done (#51)**: group ⊕ opens the folder picker and
  lands the new session inside that group (dock-group clustering + persisted
  membership via the E12-02 plumbing); plain "+ session" still lands
  ungrouped. e2e stubs the native dialog, asserts nesting + relaunch
  persistence.
- 2026-07-21 — **P2-E12-02 done (#50)**: rail renders persistent groups as
  named/colored collapsible sections (create via "+ group", double-click
  rename, dot-click recolor cycle, ✕ delete → members ungrouped, collapse in
  localStorage); grid clusters a group member's panel with its siblings'
  dockview group; sessions:create carries groupId so membership persists from
  birth. e2e: empty group survives relaunch; delete removes. 116 unit + 15
  e2e green.
- 2026-07-21 — **P2-E12-01 done (#49)**: persistent-group model in the
  workspace store (PersistedGroup: id/name/color/notifyScope; sessions gain
  groupId), CRUD + membership IPC (`groups:*`, main-minted ids, validated
  input), preload bridge, dangling-groupId cleanup on load, delete-group →
  members ungrouped. 116 unit tests green.

- 2026-07-21 — **E12 expanded + issues filed** (`/pm plan`, Dan approved).
  E12 (Session groups & Feed view) broken into 9 work items (P2-E12-01…09) in
  `04-phase-2-switchboard.md`; issues #49–#57 filed, plus the previously
  unfiled P2-E8-06 as #48. E9/E10/E11/E13/E14 remain outlines (just-in-time).
  Next: `/next-item` → P2-E12-01.
- 2026-07-21 — **PR #42 MERGED to main** (Dan's call; squash, branch deleted).
  E7 richer cards + E8 pop-out complete: 2,876 insertions across 40 files,
  incl. the Playwright e2e harness (13 tests) and the reconciliation docs.
  CI green on the tip (unit ×3 OS + e2e Win/Linux). Issues #37–#47 closed.
  Phase 2 continues from main: next is `/pm plan` to expand E9–E14.
- 2026-07-21 — **Plan ↔ DESIGN.md reconciliation** (Dan asked for a full
  cross-check; docs-only, no code). The E7–E11 break-out of Phase 2 had
  silently dropped ~half of DESIGN §8's Phase 2 list. Fixed across four docs:
  (a) `04-phase-2-switchboard.md` — new epics **E13 Dispatch v1** and **E14
  Notifications v2 + event feed v2 + service status**; restored into existing
  epics: command palette + keyboard vocabulary (E9), `get_session_context` +
  context-transfer L3 (E11), repo auto-grouping + focus-state persistence
  (E12), **P2-E8-06 display reconnect offer** (new item, not yet filed); OQ #9
  merge-endgame spike note + OQ #1 composer-sequencing note; exit criteria +
  order updated; E8-03's stale "never kills it" wording corrected to
  suspend-on-close. (b) `DESIGN.md §8` — demoted to Phase 3 (Phase 2 was
  overfull): watchers + undercard tray, tray mode + session archive v1, fleet
  snapshots + layout DSL + restore confirm gate; Phase 2 list now names
  persistent groups explicitly. (c) `03-later-phases.md` — E7–E14 reference +
  Phase 3 inherited-items note. (d) This file — E9–E14 outlines, ClaudeMon
  (OQ #8) nudge under blockers. Next `/pm plan` should expand from the
  reconciled plan.
- 2026-07-21 — **Owner design direction captured + tab polish** (Dan): (a)
  DESIGN.md "Persistent groups as containers" — explicitly-created named groups
  that persist when empty, open-into-group, move-sessions-between-groups; filed
  as plan **E12 — Session groups & Feed view** (outline, to sequence after E8).
  (b) Feed is confirmed first tab + default view (already §5.10) — reordered the
  shipped strip to Feed-first; Feed stays a "soon" placeholder and Terminal is
  the interim default until the Feed renderer is built (E12). (c) Made the
  selected view-tab clearly readable (accent top stripe + elevated fill + bold +
  --tab-lift shadow). 111 unit + 13 e2e green.
- 2026-07-21 — **CI GREEN on the branch tip** (all jobs: unit ×3 OS + e2e
  Windows/Linux). Two e2e-only flakes fixed while landing E8: (1) Linux/xvfb
  intermittently won't open the 2nd popout window → popout window-count tests
  `test.skip` on Linux (covered on Windows+macOS, logged); (2) Windows "Worker
  teardown timeout" despite all tests passing — a popped-out child window +
  node-pty grandchildren outlived `app.close()`; harness now force-kills the
  whole process tree (taskkill /T /F). Also: close popouts via their own
  `window.close()` in tests (matches the OS X-button; Playwright `page.close()`
  hard-kills and skips dockview's dock-back).
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
