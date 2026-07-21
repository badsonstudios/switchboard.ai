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
transfer. (E9/E10/E11 work items get filed just-in-time as E7/E8 near exit —
per `00-process.md`, we do NOT bulk-file the whole phase.)

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
  closing its OS window **docks the session back and never kills it**
  (DESIGN.md §"Orchestrator / subwindow model"); the rail keeps tracking a
  popped-out card. (The session survives because the PTY lives in the main
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

---

## E9 — Attention-driven layout (outline)

Layout modes (grid/focus/queue), attention queue + hotkeys (Ctrl+Space / Ctrl+
1..9), idle collapse, urgency strip, presentation ladder, pinning contract,
batch permission handling (§5.8). Filed just-in-time.

## E10 — Approval surfaces v1 (outline — DESIGN's crown jewel)

The in-app approve/deny UI over the S-03 HOOK PATH: PreToolUse hold → card
flips to a review bar (diff + allow/deny/allow-all) → decision returned to the
CLI. Depends only on the S-03 verdict + Monaco (both in hand). §5.16.

## E11 — Session Bus & context transfer (outline)

Session Bus MCP server (`list/get/send/publish`), @-references in a prompt
composer, drag-drop text/files between sessions, context chips + summary
handoff (Level 2). The signature "sessions aware of each other" feature.
§5.2–5.5.

## E12 — Session groups & Feed view (outline — owner-requested 2026-07-21)

Two owner requests captured from hands-on use; sequence after E8 (the card +
pop-out surfaces they build on are done). Governing spec: DESIGN.md "Layout
hierarchy → Persistent groups as containers" and §5.10.

- **Persistent groups as containers.** Explicitly-created named groups that
  persist even when empty (durable record: name, color, notification scope), in
  the sidebar/grid. Create / rename / recolor / delete; deleting a group drops
  its sessions back to ungrouped. Coexists with emergent repo/folder
  auto-groups (which still vanish when empty); user-made groups win (S4).
- **Open-into-group.** A group's ⊕ opens the new session *inside* that group
  (inherits the group's scope/identity defaults) — the E8-04 main-grid
  targeting generalizes to "target this group's dockview group".
- **Move-between-groups.** Drag a session from ungrouped or one group into
  another, from the rail or the grid; membership is persisted per session.
  (Dockview supports the grid drag; the rail needs its own DnD.)
- **Feed view v1 (§5.10).** The rendered read-only session view (assistant
  text, tool calls, diffs, sidechains as themed blocks; verbosity presets;
  "waiting in Terminal" chip). Per DESIGN §5.10 it is the **first tab and the
  default view** — E8-05 shipped the tab strip with Feed as a disabled "soon"
  placeholder and Terminal as the interim default; this item builds the
  renderer and flips the default to Feed.
- **View-tab set alignment.** Reconcile the shipped strip (Feed · Terminal ·
  Diff · Files) with the §5.10 canonical set (Feed · Terminal · Changes ·
  History · Inspector) once those views exist.

---

## Exit criteria (Phase 2 ships when)
1. The 7–8 session experience works: cards are information-rich, attention
   routing (queue + hotkeys) is the primary workflow, idle sessions collapse.
2. A session can pop out to a second monitor and rescue on display change.
3. In-app approvals handle a real permission prompt without dropping to the TUI.
4. Two sessions can exchange context via the bus.
5. Litmus test passes on everything shipped.

## Order
E7 first (fast win, owner's ask) → E8 (groundwork exists) → then E9/E10/E11
sequenced by feedback; approvals (E10) can jump ahead if the manual TUI
approval flow becomes the daily pain the design predicts.
