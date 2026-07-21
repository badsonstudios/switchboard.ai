# Phase 2 — The Switchboard

**Theme:** sessions become aware of each other; the attention system matures;
the session window grows up (richer cards, layout modes, pop-outs).

**Prerequisite:** Phase 1 merged (the app shell, session core, hooks,
transcripts, git, persistence). Authoritative feature list: DESIGN.md §8
"Phase 2". This file breaks it into epics + work items.

**Sequencing intent (why this order):** DESIGN's §8 notes call Approval
Surfaces the crown jewel and suggest it early. We deliberately open instead
with **E7 Richer Cards** — it wires data the app already collects (transcript
tokens, git status, state machine, autonomy) into the session card, so it's a
fast, low-risk, visibly-satisfying win and the thing the owner asked for first.
Pop-outs (E8) follow because the Phase-1 display-fingerprint groundwork already
exists. Then the heavier signature epics: presentation/attention (E9),
approvals (E10), and the Session Bus (E11).

**Epics:** E7 Richer session cards · E8 Pop-out & multi-monitor · E9
Attention-driven layout · E10 Approval surfaces v1 · E11 Session Bus & context
transfer · E12 Session groups & Feed view · E13 Dispatch v1 · E14
Notifications v2, event feed v2 & service status. (E9–E14 work items get filed
just-in-time as the preceding epics near exit — per `00-process.md`, we do NOT
bulk-file the whole phase.)

> **Reconciliation note (2026-07-21):** a DESIGN.md §8 cross-check found the
> original E7–E11 break-out had dropped several Phase 2 features. E13/E14 and
> the additions inside E8/E9/E11/E12 below restore them; three items were
> explicitly demoted to Phase 3 (watchers + undercard tray, tray mode +
> session archive, fleet snapshots + layout DSL) — DESIGN.md §8 updated to
> match.

---

## E7 — Richer session cards (Identity v2 + live telemetry)

*Goal: a card tells you what the session is, what it's doing, and what it's
costing — at a glance. Uses existing data; mostly UI wiring.*

- **P2-E7-01 · Live usage & cost on the card — M (§5.13).** Surface the
  TranscriptWatcher's per-session token totals (in/out/cache) + a derived cost
  estimate as a compact usage bar in the card header and rail row. Aggregate
  total in the status bar.
  *Done when:* a running session shows live-updating tokens and an estimated
  cost; the status bar shows the workspace total; numbers survive a resume.
- **P2-E7-02 · Git context line — S (§5.11).** A one-line branch + dirty-count
  indicator on the card header, from GitService (already built), refreshed on
  focus and on Stop.
  *Done when:* the card shows `⎇ branch ·  N changed` for a repo folder,
  nothing for a non-repo, and it updates after the agent edits files.
- **P2-E7-03 · Autonomy badge + editable task label — S (§5.11).** Show the
  session's autonomy mode as a badge on the card; let the user set a freeform
  task label (persisted with the card record) distinct from the folder title.
  *Done when:* the badge reflects the spawn autonomy; a task label round-trips
  across restart.
- **P2-E7-04 · Plan-as-progress chip — M (§5.11, OQ #13).** Extract TodoWrite
  plan state from the transcript (S-05 proved viable) and render a compact
  "3/5 steps" progress chip on the card; degrade to the task label when no plan
  is present.
  *Done when:* a session running a TodoWrite plan shows live step progress; a
  session without one shows no chip and does not error.
- **P2-E7-05 · Suspended cards in the rail — S.** Close the Phase-1 gap: the
  rail lists ALL cards (from `knownCards`), suspended ones included, so a
  restored-but-not-yet-resumed session is navigable from the rail, not only the
  grid. Clicking a suspended rail row focuses + resumes it.
  *Done when:* after relaunch, every restored card appears in the rail before
  it is focused, with a "suspended" affordance.

**E7 exit:** a 5-session workspace reads at a glance — identity, live status,
cost, git, and plan progress — and the rail mirrors every card. Litmus
(PHILOSOPHY §4) checked on each visible surface.

---

## E8 — Pop-out & multi-monitor (milestone: Phase 2; issues filed 2026-07-20)

*Goal: tear a session card out into its own OS window and place it on any
monitor; geometry persists and rescues like the main window does.*

**Spike outcome (2026-07-20):** dockview 7 has a first-class popout API
(`addPopoutGroup` + `onDidAddPopoutGroup`/`onDidRemovePopoutGroup`/
`onDidOpenPopoutWindowFail`/`getPopouts`). It opens a **same-origin** window via
`window.open(popoutUrl)` and adopts the group's DOM into it while the JS stays
in the opener — so the terminal keeps running without a preload in the popout
window. The Electron integration (P2-E8-01, done as the spike foundation):
a built `popout.html` renderer entry, and a **narrow** `setWindowOpenHandler`
allowance scoped to our own same-origin `popout.html` (everything else still
denied — §5.29 posture preserved). A ⬏ control on each card calls
`addPopoutGroup`. **Blocking risk to verify before building the rest of E8:**
whether the popout actually opens and the adopted xterm renders correctly under
sandbox + contextIsolation + CSP — a human-with-a-second-monitor test.

Work items:
- **P2-E8-01 · Popout foundation — M. [DONE as spike]** popout.html entry,
  scoped window-open allowance, ⬏ control, `addPopoutGroup` wiring.
  *Done when:* clicking ⬏ opens the card in its own OS window and its terminal
  keeps working. **(Awaiting Dan's live verification.)**
- **P2-E8-02 · Popout geometry persistence — M (§7).** Persist each popout's
  bounds + display fingerprint in the workspace store; restore on relaunch;
  rescue to the main window when its display is gone (reuse the Phase-1
  missing-display rescue).
  *Done when:* a popped-out card returns to the same monitor/position after
  relaunch, and rescues into the grid when that monitor is absent.
- **P2-E8-03 · Rejoin & lifecycle — S.** A popped-out card can rejoin the grid;
  closing its OS window **docks the card back suspended — the record survives,
  the live process ends** (as revised by E8-04 item 5, 2026-07-21; DESIGN.md
  §"Orchestrator / subwindow model" updated to match); the rail keeps tracking
  a popped-out card. (The session survives because the PTY lives in the main
  process and the renderer re-attaches to its ring buffer on dock-back — the
  S-07 re-attach model, no new lifecycle code needed.)
  *Done when:* pop-out → rejoin round-trips cleanly (terminal alive after
  dock-back) and a popped-out card is still navigable from the rail.
- **P2-E8-04 · Pop-out UX & multi-monitor correctness — M.** Real-use fixes
  found on a 3-monitor extended desktop (Dan, 2026-07-21):
  1. **New sessions land in the main grid**, not as tabs in whatever popout is
     active (dockview `addPanel` targets the active group — force a
     main-window group).
  2. **Popout window honors its saved bounds on the right monitor.** Root
     cause: `setWindowOpenHandler` returned `overrideBrowserWindowOptions`
     without `x/y/width/height`, so Electron ignored the `window.open`
     `features` (left/top/width/height dockview passes) and cascaded the window.
     Parse `features` → set screen-absolute bounds. Fixes both initial
     placement and E8-02 restore-across-relaunch (the E8-02 test only asserted
     window *count*, not position — coverage gap).
  3. **No `NaN`-garbled terminals after a layout change.** FitAddon computes
     cols/rows from a transiently zero-size container and caches NaN; guard
     `fit()` against non-finite/zero dims and force a re-fit + `term.refresh()`
     when a panel becomes visible/active.
  4. **Pop-out button becomes a toggle** (dock out ⇄ dock back in, session
     stays alive) — see E8-05 for its new home on the card header.
  5. **Closing the popout OS window suspends the session** (ends the live
     process, keeps the card + record, resumes on focus) — Dan's decision
     2026-07-21, which **revises E8-03/DESIGN.md** ("docks back, never kills")
     to "docks back **suspended**". Distinguish a real window-close from a
     button-driven dock-back via a flag so the toggle stays alive. **Update
     DESIGN.md §"Orchestrator / subwindow model".**
  *Done when:* on a multi-monitor setup a popout reopens at its exact saved
  position; new sessions never land in a popout; terminals never render NaN
  garbage after move/resize; the header pop-out button toggles in/out; closing
  the window suspends (card returns, resumes on focus). e2e asserts popout
  *position* (not just count), new-session-to-main, toggle, and suspend-on-close.
- **P2-E8-05 · Session card header + view-tabs (mockup v1) — M.** Adopt the
  `mockups/main-window-v1.html` look Dan called out. Card header (`.chead`):
  accent left-border, icon, name, live task label, status pill, and window
  controls (prominent `⤢` pop-out toggle + `⋯`) top-right. A view-tab strip
  (`.vtabs`) under it: **Terminal** (live CLI) and **Diff** (git diff, moved
  in-card from the separate panel) as real tabs; **Feed** and **Files** shown
  as disabled "soon" tabs (their views are §5.10/future). E7 telemetry
  (usage/git/plan/autonomy) stays, reorganized into a clean secondary line.
  *Done when:* a session card matches the mockup's header + tab visual; the
  `⤢` control pops out/in; Terminal and Diff switch in-card; no dead-looking
  controls (Feed/Files clearly "soon").
- **P2-E8-06 · Display reconnect offer — S (§7). [filed: #48]** The third
  leg of the §8 multi-monitor list (E8-02 shipped persistence + rescue; this
  was dropped in the original break-out). When a known display fingerprint
  reappears (docking back at the desk), the Feed offers a one-click "restore
  layout?" — never automatic (the new display might be a projector).
  *Done when:* reconnecting a saved monitor produces the Feed offer; accepting
  restores the popout(s) to that display; ignoring it changes nothing.

---

## E9 — Attention-driven layout (outline)

Layout modes (grid/focus/queue), attention queue + hotkeys (Ctrl+Space / Ctrl+
1..9), idle collapse, urgency strip, presentation ladder, pinning contract,
batch permission handling (§5.8), plus the **command palette + complete
keyboard vocabulary** for session lifecycle — spawn / focus / archive /
review / merge (§8; every mouse flow has a key path — restored 2026-07-21,
dropped in the original break-out). Filed just-in-time.

## E10 — Session tab & Approval surfaces v1 (milestone: Phase 2; issues #59–#63 filed 2026-07-21)

*Goal: the renamed **Session** tab becomes the primary working surface — the
VS Code-extension shape: rendered conversation + prompt composer + inline
approvals. Owner decision 2026-07-21 (hands-on E12 feedback) — DESIGN.md §5.10
amended (composer + approvals are input ROUTES to the real CLI; Terminal stays
the escape hatch). Pulls forward OQ #1's composer and the §5.16 crown jewel.
Jumped ahead of E9 per the plan's own "if TUI approvals become the daily
pain" clause.*

Work items:
- **P2-E10-01 · Tab rename: Feed → Session — S (§5.10).** Rename the view tab
  (i18n, tests, canonical set: Session · Terminal · Changes · History);
  "waiting in Terminal" chip re-labeled "continue in Terminal" and scoped to
  raw-TUI states (needs-input), no longer permission prompts (E10-04 takes
  those).
  *Done when:* the strip reads Session · Terminal · Changes · History-soon;
  e2e updated.
- **P2-E10-02 · Prompt composer v1 — M (§5.10, OQ #1).** Input box docked at
  the bottom of the Session tab; Enter submits (writes prompt + CR to the
  live PTY), Shift+Enter for newline; disabled state when the session is
  suspended (submit resumes first). Research pass on the VS Code extension's
  composer UX before building.
  *Done when:* a prompt typed in the Session tab drives the real CLI (blocks
  appear; Terminal shows the same turn); works on a resumed session; e2e
  proves composer → PTY → rendered response with the fake provider.
- **P2-E10-03 · PreToolUse hold + decision round-trip — M (§5.16, S-03).**
  HookListener gains a hold mode: a PreToolUse call for a gated tool parks
  the HTTP response until the UI answers (allow / deny), then returns the
  hook verdict to the CLI. Timeout (config, ~60s) fails OPEN to the CLI's own
  TUI prompt — our breakage never blocks a session.
  *Done when:* with hold enabled, a gated tool call pauses; app-side allow
  runs it, deny blocks it, timeout falls back to the TUI (all three
  unit/e2e-proven via the hook listener).
- **P2-E10-04 · Inline approval bar — M (§5.16).** On a held PreToolUse the
  Session tab flips up a review bar: tool + input summary, diff preview for
  file edits (Monaco in hand), Allow / Deny / Allow-all-this-session.
  Answers route through E10-03; the OS notification stays but becomes
  secondary (quiet when the window is focused).
  *Done when:* a real permission prompt is answered entirely in the Session
  tab — no Terminal switch, no OS alert needed; deny sends the refusal.
- **P2-E10-05 · Composer options row — S (§5.10).** The strip under the
  composer: autonomy badge (click to change for THIS session's next spawn),
  model indicator, working-status spinner — the extension-style affordances.
  *Done when:* the row renders live data; autonomy change round-trips to the
  next resume.

**E10 exit:** a user can run a whole coding turn — prompt, watch, approve —
without ever opening the Terminal tab; Terminal remains one click away and
raw TUI states route there explicitly. Litmus checked per surface.

## E11 — Session Bus & context transfer (outline)

Session Bus MCP server (`list/get/send/publish` **+ `get_session_context`**),
@-references in a prompt composer, drag-drop text/files between sessions,
context chips + summary handoff (Level 2), **and context transfer Level 3
(fork-session adoption) behind an experimental flag** (both restored
2026-07-21 — dropped in the original break-out). The signature "sessions
aware of each other" feature. §5.2–5.5.

*Sequencing note (OQ #1):* DESIGN wants the prompt composer validated EARLY in
Phase 2, but E11 runs late in this plan — a knowing deviation. If the wait
starts to hurt (or E9's keyboard work wants a composer anyway), pull a minimal
composer spike forward ahead of the rest of E11.

## E12 — Session groups & Feed view (milestone: Phase 2; issues #49–#57 filed 2026-07-21)

*Goal: groups become the durable organizing unit of the sidebar/grid, and the
Feed becomes the default, pleasant-to-read view of a session. Owner-requested
2026-07-21; sequenced after E8 (builds on its card + tab surfaces). Governing
spec: DESIGN.md "Layout hierarchy → Persistent groups as containers", §5.10,
§5.25, §7.*

Work items:
- **P2-E12-01 · Group model + store — M.** Durable persistent-group records
  (id, name, color, notification scope) in the workspace store; session records
  gain a `groupId`; CRUD over IPC; deleting a group drops members to ungrouped.
  No UI yet.
  *Done when:* groups round-trip a restart; an empty group persists; delete-
  group moves its sessions to ungrouped (unit-tested store + IPC guards).
- **P2-E12-02 · Groups in the rail + grid — M.** *(depends: 01)* Sidebar
  renders groups as named/colored collapsible sections with create/rename/
  recolor/delete; the grid clusters a group's sessions into their own dockview
  group.
  *Done when:* an empty "IT" group created in the rail survives restart;
  rename/recolor/delete work; grouped sessions cluster in the grid. e2e covers
  create-empty-group → restart.
- **P2-E12-03 · Open-into-group — S.** *(depends: 02)* A group's ⊕ spawns the
  new session inside that group (inherits group scope defaults) — generalizes
  E8-04's "force main-window group" targeting.
  *Done when:* ⊕ on a group lands the session in that group's dock group with
  membership persisted; the plain New Session still lands ungrouped in the
  main grid.
- **P2-E12-04 · Move-between-groups — M.** *(depends: 02)* Drag a session
  between groups/ungrouped in the grid (dockview drag) and in the rail (custom
  DnD); membership persists.
  *Done when:* both drag paths update membership and survive restart; dropping
  into a group visually joins it.
- **P2-E12-05 · Repo/folder auto-grouping — M (§7).** *(depends: 02)* Emergent
  groups for sessions sharing a repo/folder; vanish when empty; explicit user
  groups always win (S4).
  *Done when:* two sessions in one repo auto-group; an explicit group
  assignment overrides; the auto-group disappears when emptied; no auto-group
  for singletons.
- **P2-E12-06 · Feed view v1: transcript→blocks renderer — M (§5.10).** The
  read-only rendered view behind the existing "soon" Feed tab: assistant text
  (markdown + highlighting), tool calls as one-line collapsed blocks (click to
  expand), diffs, sidechains folded. Rendered from TranscriptWatcher events;
  strictly no input (Non-Goals guardrail).
  *Done when:* a live session's Feed shows blocks appearing in near-real-time;
  expand/collapse works; a transcript-less session shows an empty state, not
  an error.
- **P2-E12-07 · Feed v1: verbosity + waiting-chip + default flip — M.**
  *(depends: 06)* `quiet | normal | firehose` presets per session, switchable
  live; "waiting in Terminal" chip when the CLI needs input (jumps to the
  Terminal tab); flip the default tab from Terminal to Feed.
  *Done when:* presets change density without reload; the chip appears on a
  permission prompt and jumps correctly; new and restored sessions open on
  Feed.
- **P2-E12-08 · Focus-state persistence — S (§5.25).** Persist the focused
  session and each session's active view-tab; restore lands exactly where the
  user was.
  *Done when:* relaunch restores the focused card and per-session active tabs
  (e2e: switch tab + focus, relaunch, assert).
- **P2-E12-09 · View-tab set alignment — S (§5.10).** *(depends: 06)* Rename
  Diff→**Changes** per the canonical set (Feed · Terminal · Changes · History ·
  Inspector); swap the "Files (soon)" placeholder for "History (soon)".
  *Done when:* the strip reads Feed · Terminal · Changes · History-soon; no
  dead controls.

**E12 exit:** groups are the durable organizing unit (create empty, open-into,
move-between, auto-group coexists), the Feed is the default view and pleasant
to read, and a relaunch puts you exactly where you left off. Litmus
(PHILOSOPHY §4) checked on each surface.

---

## E13 — Dispatch v1 (outline — restored 2026-07-21)

Session-to-session handoff with deliberate context amounts (§5.15): role
templates (built-in Code Reviewer / Doc Writer / PR Author + user-defined
first-class), manual dispatch from session card / command palette, clean-room
+ briefed context policies, workspace policy (same-folder | fresh-worktree),
round-trip results as Feed events with one-click "inject findings into author
session", lineage nesting in the rail ("↳ Review of X", ephemeral by default).
Agent-initiated `spawn_session` and rules-engine auto-dispatch stay Phase 3
(Dispatch v2). Depends on E11's context packages — sequence after it.

## E14 — Notifications v2, event feed v2 & service status (outline — restored 2026-07-21)

Three §8 items that share the event pipeline, dropped in the original
break-out; they interleave anywhere after E9:

- **Notifications v2 (§5.9).** Rules engine (when [event] in [session | any] →
  actions), per-session distinct sounds, TTS announcements, phone push
  (ntfy / Pushover), webhook, actionable Allow/Deny toasts (keystroke to PTY),
  visibility-aware rule conditions, quiet hours + missed-events digest.
  Actionable toasts pair naturally with E10 — consider landing that slice with
  approvals.
- **Event feed v2 (§5.12).** Inline actions on events, filters
  (session / severity / type), severity tiers with visual weight, group-by-
  session toggle, the full §5.12 event catalog.
- **Status bar service health (§5.14).** Anthropic Statuspage polling
  (status + unresolved incidents), status-bar dot + tooltip, incident Feed
  events, local corroboration banner (multiple sessions erroring → "possible
  provider issue" before the status page catches up).

---

**Embedded empirical spike (OQ #9 — carried from `03-later-phases.md` notes,
restored 2026-07-21):** the merge-conflict endgame wants its 7–8-real-branches
experiment once parallel worktree use is real. Schedule it when E11 makes
multi-session work routine; findings feed Phase 3's review-dashboard planning.

---

## Exit criteria (Phase 2 ships when)
1. The 7–8 session experience works: cards are information-rich, attention
   routing (queue + hotkeys) is the primary workflow, idle sessions collapse.
2. A session can pop out to a second monitor and rescue on display change.
3. In-app approvals handle a real permission prompt without dropping to the TUI.
4. Two sessions can exchange context via the bus.
5. A clean-room review dispatched from a session round-trips its findings back
   to the author.
6. A notification rule routes a needs-permission event to a chosen channel,
   and an actionable toast can answer it without switching windows.
7. Litmus test passes on everything shipped.

## Order
E7 first (fast win, owner's ask) → E8 (groundwork exists) → E12 (owner-
requested, builds on E8's card/tab surfaces) → **E10 (jumped ahead
2026-07-21: owner's hands-on feedback confirmed exactly the "TUI approvals
are the daily pain" clause — plus the Session-tab pivot)** → E9/E11 sequenced
by feedback → E13 after E11 (needs its context packages) → E14 interleaves
anywhere after E9 (actionable-toast slice pairs with E10's approval bar).
