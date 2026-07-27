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

**Epics:** E7 Richer session cards · E8 Pop-out & multi-monitor · **E15
Structural foundations** · E9 Attention-driven layout · E10 Approval surfaces
v1 · E11 Session Bus & context transfer · E12 Session groups & Feed view · E13
Dispatch v1 · E14 Notifications v2, event feed v2 & service status. (E9–E14
work items get filed just-in-time as the preceding epics near exit — per
`00-process.md`, we do NOT bulk-file the whole phase.)

> **Architecture review inserted E15 (2026-07-26).** A full review
> (`docs/architecture-review-2026-07-26.md`) found that the extensibility seam
> covers only provider spawning, that the adapter contract cannot express a
> second provider, that themes are not the token maps §5.20 promises, and that
> the renderer has no state layer for E9's cross-cutting per-session state.
> **E15 runs NEXT — ahead of the rest of E9** — because E9-05/E9-07 are
> blocked on it and everything in it gets materially more expensive once E9
> lands eleven more items on the current shape. Numbered E15 (next free epic
> number); sequenced third. Owner decision the same day: **third-party plugin
> support is a real goal**, so capability brokering ships full-size rather than
> trimmed to internal structure.

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

## E15 — Structural foundations (milestone: Phase 2; runs NEXT, added 2026-07-26; issues #98–#111 filed 2026-07-27)

> Issue numbers map straight through: P2-E15-01 → #98 … P2-E15-14 → #111.

*Goal: make the seams real before the app gets big enough that they can't be.
Four things the architecture review found: the provider contract can't describe
a non-Claude CLI, there is no renderer-side contribution surface at all (8 of
§5.23's 9 first-party extensions are renderer contributions), themes aren't the
token maps §5.20 promises, and the renderer has no state layer for the
cross-cutting state E9 is about to need. Governing spec: DESIGN.md §5.3, §5.20,
§5.23, §5.26, §5.29. Findings: `docs/architecture-review-2026-07-26.md`
(AR-P0-1 … AR-P2-14).*

**Why now, not later.** E9-05 and E9-07 are hard-blocked on E15-08. Every other
item is cheap today and an audit later. And the Phase-4 plugin-API gate ("2–3
dissimilar internal consumers on the seams") is currently **unreachable** — the
count is 1 and structurally cannot grow, because there is nothing but
`provider-adapter` to be a consumer of. E15-03 alone takes it to 4.

**Not in scope:** the real out-of-process plugin host, `utilityProcess`, typed
RPC, activation events, sandboxed webview panels, any install/distribution path.
All still Phase 4 (§5.23), and this epic is what makes that transition
mechanical instead of archaeological.

Work items:

- **P2-E15-01 · Provider adapter capability objects — M (§5.3, AR-P0-1).**
  Move `{ transcripts, hooks, resume, mcp }` onto the `ProviderAdapter`
  contract as §5.3 always specified. Session creation ASKS the adapter instead
  of assuming Claude: today `ipc.ts` hardcodes `providerId: 'claude-code'`,
  calls `hooks.buildHookSettings()` unconditionally, watches
  `~/.claude/projects` unconditionally, and owns `--resume` semantics itself.
  *Done when:* a test adapter declaring ZERO capabilities spawns a PTY-only
  session — no settings file written, no transcript watch started, no resume
  attempted — and the app degrades without erroring; the Claude adapter's
  behaviour is byte-identical (existing unit + e2e green); no
  Claude-specific branch remains in `sessions/ipc.ts`.
- **P2-E15-02 · Process-agnostic ContributionRegistry — S (§5.23, AR-P0-2,
  AR-P2-13).** *(no deps)* `ContributionRegistry` imports nothing from `main/`;
  a second instance is bootstrapped in the renderer with its own
  `bootstrap.ts`-equivalent (the one-module-imports-contributors rule holds on
  both sides). The E9-01 command set registers through it and the palette +
  dispatcher RESOLVE from it rather than importing `command-set.ts` — it is
  already a contribution point in everything but name. Decide `event-source`'s
  fate here: a point with no registrant is a guess (delete it, or give it the
  §5.14 status monitor as its first real registrant).
  *Done when:* both registries share one class; duplicate ids still throw at
  registration; commands resolve by point + id from the palette and the
  keyboard dispatcher; a fresh registry per test (no singleton leakage).
- **P2-E15-03 · Renderer contribution points: `panel`,
  `feed-block-renderer`, `status-bar-item` — M (§5.10, §5.23, AR-P0-2).**
  *(depends: 02)* The dogfood that makes the Phase-4 gate reachable. Three
  DISSIMILAR shapes, each replacing code that already exists: the view-tab
  strip is built from registered `panel` contributions (Session / Terminal /
  Changes / History / Inspector); FeedView's hardcoded block switch dispatches
  through `feed-block-renderer` resolution (Edit/Write, Bash, TodoWrite,
  thinking, generic-tool registered as separate contributors); the status bar
  renders registered `status-bar-item`s.
  *Done when:* adding a new view tab or a new block renderer requires editing
  ONLY its own module plus the renderer bootstrap — no edit to `SessionGrid.tsx`
  or `FeedView.tsx`; every contribution carries an honest manifest; the startup
  log lists renderer manifests the way `index.ts` already lists main's; consumer
  count on the seams is 4+ and `extensibility.md`'s roster table is updated to
  match reality.
- **P2-E15-04 · Capability-brokered preload bridge — M (§5.23, §5.29,
  AR-P0-2).** *(depends: 02)* The preload's ~60 hand-maintained methods become
  capability-TAGGED: one declared capability string per IPC channel
  (`sessions.read`, `sessions.spawn`, `pty.write`, `git.read`,
  `settings.write`, …), and a single main-side choke point that checks the
  caller's declared set before dispatch. First-party declares everything, so
  this is a no-op at runtime today — that is the point: the enforcement POINT
  exists, so Phase 4 wires a plugin's manifest into it instead of inventing
  one. Vocabulary gets written down in `extensibility.md`.
  *Done when:* every channel maps to exactly one declared capability (a test
  asserts no channel is untagged); a call whose context lacks the capability is
  refused and logged with the channel + capability; the existing renderer runs
  unchanged; §5.23's "main process is the sole enforcer" is true in code.
- **P2-E15-05 · Theme = a JSON token map — M (§5.20, AR-P0-3).** `ThemeName`
  stops being a two-value union; a theme becomes a `Record<token, value>`
  applied to `documentElement`. `tokens.css` stays as the built-in
  nordic/daylight presets (and remains the ONLY place raw colors live — the
  lint rule is untouched). Ship the third theme §5.20 has promised since day
  one: **high-contrast** (accessibility, not decoration), authored as JSON with
  no code change, which is the proof the map works.
  *Done when:* three themes are selectable; high-contrast is a data file, not
  code; a theme switch reaches popped-out windows (the #84 `syncDocumentFlags`
  path); the raw-color lint rule is still green; token names are enumerable
  (the future theme editor + `theme` contribution point need that list).
- **P2-E15-06 · Renderer preference persistence — S (§5.25, AR-P0-3).**
  Theme and language move from `localStorage` to the `ui` blob. The workspace
  store already documents why localStorage is unsafe here — the packaged
  renderer's loopback origin changes port per launch, so it resets every run —
  which means **theme and language almost certainly reset on every launch of a
  packaged build today**. Verify first, then fix.
  *Done when:* an e2e against the BUILT app sets a non-default theme and
  language, relaunches, and both survive; dev behaviour unchanged.
- **P2-E15-07 · Renderer session store — M (AR-P1-4).** One observable store
  (plain class + `useSyncExternalStore`; no new dependency) owning cards,
  per-card status/usage/plan/pending-permissions, and the ui blob. The
  module-level mutable maps in `SessionGrid.tsx` (`liveToCard`,
  `allowAllByLive`, `cardActions`, `dockingBackByButton`) move into it, and the
  `switchboard:groups-changed` DOM CustomEvent bus is replaced by a
  subscription. The synchronous-read requirement that currently forces
  `eventsRef` / `railSessionsRef` / `visitedRef` is the store's job — those
  refs go away, and the reasoning behind them moves into the store's docs
  (it was correct; only its home was wrong).
  *Done when:* no module-level mutable state remains in renderer components; a
  unit test constructs a store, drives it, and asserts derived rail order +
  queue order without React; two presses of `Ctrl+Space` in one frame still
  advance two steps (the batching behaviour the refs existed to protect).
- **P2-E15-08 · Presentation state into the store — M (§5.8, AR-P1-5).**
  *(depends: 07)* **Hard prerequisite for E9-05 and E9-07.** Per-card `view`
  tab, popped-out, suspended, collapsed, and dock slot move out of
  `SessionCardPanel`'s `useState` into the store + ui blob. Panel-local state
  cannot satisfy E9-05's contract ("reveal restores it to EXACTLY its prior
  dock slot or monitor") because the state must outlive the panel's unmount,
  and cannot satisfy E9-07's ("switching modes rearranges live sessions")
  because layout modes drive every card at once from the palette/queue.
  *Done when:* a card unmounted and remounted restores its exact view tab and
  slot; a hidden card's slot survives being hidden; E9-05 and E9-07 can be
  implemented without touching panel-internal state; ladder state persists
  across relaunch.
- **P2-E15-09 · Permission hold fails open on a dead window — S (§5.16,
  AR-P1-7).** `maybeHold` currently passes only when `permListeners.size === 0`,
  but listeners are registered once at IPC setup and never removed — so the
  real "nobody to ask" case (renderer crashed, window closed, headless sessions
  still running) is NOT detected and the CLI stalls the full 300s per gated
  call. Gate on window liveness instead. Consider a short renderer-ack deadline
  (~5s) separate from the 300s human-decision budget.
  *Done when:* with no live window a gated PreToolUse releases immediately with
  `{}` (the CLI's own prompt takes over) instead of holding; unit-tested with a
  stubbed window provider; the reloading-renderer replay path
  (`sessions:pendingPermissions`) still works — that case must NOT regress.
- **P2-E15-10 · Transcript drift detector + binding transparency — M (§5.26,
  AR-P1-8).** §5.26 mandates the round-trip drift detector and it was never
  built: re-serialize each parsed line, diff the key set against what we
  consumed, warn ONCE per newly-seen key. It slots in beside the `malformed`
  counter. Second half: binding state is invisible today — an unbound session
  shows an empty Session view, which is P9 (trust through transparency) failing
  on our own plumbing.
  *Done when:* a synthetic transcript line carrying an unknown field logs
  exactly one warning naming the field and is otherwise ingested normally
  (tolerant reader unchanged); the Session view distinguishes "waiting for the
  first prompt", "waiting for transcript", and "couldn't bind" — and says which.
- **P2-E15-11 · Transcript discovery I/O — S (AR-P1-8).** *(depends: 10)*
  `poll()` runs every 100ms and any session unbound past 10s triggers a full
  recursive `scan()` of `~/.claude/projects` — on the thread that also pumps
  every PTY, serves every IPC, and answers hooks. Move discovery to `fs.watch`
  on the projects root with a backoff, keeping the poll for the bound-tail
  drain.
  *Done when:* a session binds no slower than today (the S-04 ~4s discovery
  budget holds); no full recursive scan runs while every session is bound; the
  widen-after-grace fallback still binds a session whose slug math failed.
- **P2-E15-12 · Header-based CSP — S (§5.29, AR-P2-10).** `index.html` says
  itself that the meta-tag CSP works in dev by accident of Vite's script
  injection ordering, and says "revisit when IPC handlers land in E2" — E2
  landed long ago. Serve CSP as a header via `onHeadersReceived` on our own
  loopback static server. Must precede any sandboxed-webview plugin panel;
  that is when CSP becomes load-bearing.
  *Done when:* both windows (main + popout) receive the policy as a header; the
  meta tag is removed or demoted to a dev-only backstop; dev and packaged
  builds both boot clean with no CSP violations in the console.
- **P2-E15-13 · Workspace schema migration hook — S (§5.26, AR-P2-9).**
  `WorkspaceState.version` exists and `load()` never reads it. The
  field-by-field sanitization is the more robust pattern and STAYS; this adds
  the version-dispatch hook around it while there is exactly one version and it
  is free. §5.26 promises a versioned, exportable schema.
  *Done when:* `load()` dispatches on `version` with a v1 identity migration; an
  unknown FUTURE version loads read-only-safe rather than being silently
  sanitized into a lossy v1 (and says so in the log); a v0/absent version is
  treated as v1.
- **P2-E15-14 · Re-measure S-07 on the real app — S (§6, AR-P2-11).** The
  concurrency spike measured a harness — PTY + tailer + one xterm. Since then:
  dockview, Monaco (9MB bundle), live FeedView block streaming, per-card git
  polling, the slash-command scanner. E9 is about to assert the 7–8 session
  experience as the primary workflow, which is exactly where S6/S7 become
  load-bearing.
  *Done when:* 12 real sessions measured on the shipped app (visible/unoccluded
  window — the S-07 occlusion artifact is a known measurement trap); findings
  appended to `spike/findings/s-07-concurrency-perf.md` with a dated
  "real-app" section; any regression against the harness numbers is either
  fixed or filed with a named owner.

**E15 exit:** a second provider adapter could be written without touching
`sessions/ipc.ts`; a new view tab or feed block renderer is a self-contained
module; a theme is a JSON file and three of them ship; every IPC channel
carries a declared capability with a live enforcement point; the renderer has
one state authority and E9-05/E9-07 are unblocked; the drift detector is
watching for the next CLI release. Consumer count on the seams: 4+ (gate for
the Phase-4 plugin API alpha is reachable for the first time). Litmus
(PHILOSOPHY §4) applies to the two user-visible items only (E15-05 themes,
E15-10 binding states); the rest are internal and write no manual page.

---

## E9 — Attention-driven layout (milestone: Phase 2; issues #70–#80 filed 2026-07-24)

*Goal: with 7–8 sessions open, the **queue** becomes the primary workflow and
the grid a fallback — inbox-zero for agents. Everything reachable by keyboard;
idle work folds away; a session that needs you says so without stealing the
screen. Governing spec: DESIGN.md §5.8 in full, plus §8's "command palette +
complete keyboard vocabulary" line. Closes Phase 2 exit criterion #1 — the
biggest unmet one. Expanded 2026-07-24 (`/pm plan`, Dan picked E9 over
E11/E14).*

Work items:

- **P2-E9-01 · Command registry + keybinding dispatcher — M (§5.8, §8).**
  `renderer/lib/commands.ts`: `Command {id, title, category, enabled(ctx),
  run(ctx)}` + a default keymap + a document-level dispatcher. Hard rule: a
  text input (composer, rename field) or the xterm surface owns its own keys —
  a binding NEVER steals a keystroke the CLI should get (host-don't-
  reimplement). Seed commands: jump to session N (`Ctrl+1..9`, rail order),
  next/prev session, new session, close session (existing confirm), toggle
  rail, toggle Terminal tab, pop out.
  *Done when:* Ctrl+1..9 focuses the Nth rail session; typing "1" in the
  composer or the Terminal never jumps; e2e proves both directions.
- **P2-E9-02 · Command palette — M (§8, §5.8 keyboard-fail-open).**
  `Ctrl+Shift+P` opens a fuzzy-filter palette over the registry, each row
  showing its binding; `go to session <name>` entries included; commands whose
  preconditions are unmet render greyed with the reason. Enforces the §5.8
  invariant — hiding chrome never removes capability.
  *Done when:* the palette opens by hotkey, filters, runs a command, shows
  bindings, closes on Esc; e2e drives a session-lifecycle command entirely
  from the keyboard.
- **P2-E9-03 · Attention queue + jump hotkey — M (§5.8, §5.12).** A persistent
  ordered work list layered over the existing `EventFeed` (already one item
  per session): priority order **needs-permission → needs-input → crashed →
  completed-unreviewed**. `Ctrl+Space` jumps to the next one, focuses its
  card, acknowledges it, wraps at the end, no-ops on an empty queue. The queue
  is the ordering authority; the Events panel renders it.
  *Done when:* three sessions in different attention states clear in priority
  order under repeated Ctrl+Space; an answered item leaves the queue; ordering
  unit-tested + e2e.
- **P2-E9-04 · Urgency strip + delayed urgency reset — S (§5.8, i3 urgency
  hint).** An always-visible global strip: one lamp per session, colored by
  status, click to focus, pinned first, present regardless of layout mode.
  After a jump the arrived-at lamp stays lit ~1.5s so you can still see WHICH
  session called you.
  *Done when:* the strip reflects live status for every session incl.
  suspended, click focuses, the lamp lingers post-jump, and it stays visible
  in all three layout modes; e2e.
- **P2-E9-05 · Presentation ladder + reveal contract — M (§5.8).**
  ***(depends: P2-E15-08 / #105 — hard block.* Presentation state currently lives in
  `SessionCardPanel`'s `useState`; "restores it to EXACTLY its prior dock slot"
  requires state that outlives the panel's unmount. Do not start this before
  E15-08 lands — see AR-P1-5.)* Per-session
  `expanded → collapsed strip → tabbed → hidden`. Hidden removes the card from
  the workspace entirely — the session lives on in the rail, its lamp, and the
  events list. Reveal triggers: needs-attention (permission / input / done) or
  a user click anywhere; reveal restores it to EXACTLY its prior dock slot or
  monitor.
  *Done when:* a hidden session reveals on a permission hold into its original
  slot; ladder state persists across relaunch (ui blob); e2e.
- **P2-E9-06 · Presentation policy + auto-minimize on submit — S (§5.8).**
  Setting `always-visible | auto-collapse | auto-hide`; global default is
  **auto-collapse** (litmus: a new user watching their card vanish on first
  submit fails intuitive-first), with per-group and per-session overrides.
  Submitting a prompt collapses the card; `Stop` (done) or a needs-human
  status restores it.
  *Done when:* submit collapses under the default and restores on done;
  auto-hide honors the E9-05 reveal contract; a per-session override beats the
  global; e2e.
- **P2-E9-07 · Layout modes grid · focus · queue + maximize toggle — M
  (§5.8).** ***(depends: P2-E15-08 / #105 — hard block.* Modes drive every card at
  once from the palette/queue; panel-local state can't be driven from outside
  the panel — see AR-P1-5.)* Per-workspace mode, persisted in the ui blob, switchable from the
  palette and a binding: `grid` (today) · `focus` (one large + slim strips) ·
  `queue` (only attention-needing sessions expanded). Focus mode is a
  COMPOSITION of ladder states, not a bespoke mode; double-clicking a session
  header toggles maximize and restores the prior layout on repeat.
  *Done when:* switching modes rearranges live sessions and survives relaunch;
  queue mode expands a session the instant it needs attention; maximize
  round-trips; e2e.
- **P2-E9-08 · Idle collapse & aggregation — S (§5.8; i3 tabbed layouts).**
  Idle sessions collapse to compact rows; more than ~3 idle fold into a single
  expandable "N idle sessions" row. Working / errored / focused sessions
  always keep their own row.
  *Done when:* 4 idle sessions become one row, a status change pops the right
  one back out, and the focused session is never swallowed; unit + e2e.
- **P2-E9-09 · Pinning contract — S (§5.8; VS Code / IntelliJ pinned-tab
  semantics).** One-gesture pin/unpin (rail menu + palette + binding). A
  pinned session sorts first, never scrolls out of view under overflow, and is
  exempt from EVERY bulk operation — bulk-close, idle aggregation,
  auto-collapse sweeps, future auto-eviction. Pinned ≠ always-expanded:
  pinning protects existence and position, not size.
  *Done when:* a pinned IDLE session neither aggregates nor auto-collapses,
  still sorts first after relaunch, and survives a bulk-close; e2e.
- **P2-E9-10 · Focus-stealing policy — S (§5.8; i3
  `focus_on_window_activation`).** Global setting + per-session override:
  `smart` (default) · `urgent` · `focus` · `none`, governing whether a session
  that finishes or needs attention may grab focus.
  *Done when:* under `urgent` nothing ever steals focus (lamp only); under
  `smart` a visible card focuses while a hidden one only marks urgent; the
  rule is unit-tested and the setting persists; e2e.
- **P2-E9-11 · Batch permission handling — M (§5.8; octomux pattern).**
  Similar pending permission prompts across sessions group into one card
  answered once, riding the existing `sessions:decidePermission` /
  `sessions:allowAllSession` IPC from E10.
  *Done when:* two sessions holding the same tool + argument shape present as
  one grouped prompt, one Allow answers both, and declining one leaves the
  other held; e2e via the real hook listener. *(The one item that may slip to
  E14 if this batch should stay layout-pure.)*

**E9 exit:** with 7–8 sessions open the queue is the primary workflow
(Ctrl+Space to inbox-zero), the grid is a fallback rather than the interface,
idle sessions fold away, every mouse flow has a key path, and the palette
keeps everything reachable when chrome is hidden. Litmus checked per surface.

## E10 — Session tab & Approval surfaces v1 (milestone: Phase 2; issues #59–#64 filed 2026-07-21)

*Goal: the renamed **Session** tab becomes the primary working surface — the
VS Code-extension shape: rendered conversation + prompt composer + inline
approvals. Owner decision 2026-07-21 (hands-on E12 feedback) — DESIGN.md §5.10
amended (composer + approvals are input ROUTES to the real CLI; Terminal stays
the escape hatch). Pulls forward OQ #1's composer and the §5.16 crown jewel.
Jumped ahead of E9 per the plan's own "if TUI approvals become the daily
pain" clause.*

Work items:
- **P2-E10-01 · Tab rename + Terminal hidden by default — M (§5.10, revised
  2026-07-21 from owner screenshot).** Rename Feed → Session (i18n, tests);
  **Terminal leaves the default strip** — shown via the card ⋯ menu /
  per-session toggle or the "continue in Terminal" chip (re-labeled from
  "waiting in", scoped to raw-TUI needs-input states; E10-04 takes
  permission prompts). Shown/hidden persists per session (ui blob).
  *Done when:* default strip reads Session · Changes · History-soon; the ⋯
  menu shows/hides Terminal and the choice survives relaunch; the chip
  surfaces it on demand; e2e updated.
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
  composer: autonomy badge (click to change for THIS session's next spawn —
  the extension's "Edit automatically" dropdown analog), model indicator,
  working-status spinner.
  *Done when:* the row renders live data; autonomy change round-trips to the
  next resume.
- **P2-E10-06 · Rich tool blocks v2 — M (§5.10 block presentation, owner
  screenshot).** Upgrade the E12-06 renderer to the extension look: timeline
  dot gutter; Edit/Write blocks get a header (`Edit <path>`, "Added N lines")
  + inline syntax-highlighted diff preview (green/red shading, click-expand);
  Bash blocks get `Bash <description>` headers with independently expandable
  IN/OUT sections; thinking collapses to "Thought for Ns" (duration from
  timestamps); TodoWrite renders as an Update-Todos checklist block.
  *Done when:* a real session's turn reads like the reference screenshot —
  prose, thought-line, Edit-with-diff, Bash IN/OUT — each block type
  expand/collapses; e2e covers Edit-diff and Bash IN/OUT via a synthetic
  transcript.

- **P2-E10-07 · Composer slash commands (full support) — M→L (§5.10, §5.17).
  [Issue #68, filed on pickup 2026-07-24. Owner scope call at plan gate:
  ⋯-menu session controls ship /clear + /compact (with confirm on clear);
  /model · /mcp entries and plugin/MCP command discovery stay future work.]**
  Two halves:
  (a) **Autocomplete** — typing `/` in the composer pops a command list (the
  VS Code extension pattern): the CLI's built-ins + the project's
  skills/commands (registry §5.19 knows them). Selecting inserts; submission
  stays a plain PTY write (host-don't-reimplement: the CLI executes).
  (b) **Session controls** — the commands a user reaches for from the
  Session tab without remembering syntax, `/clear` first (owner: "I have no
  way to clear a conversation"): surface as composer actions/⋯ menu entries
  that write the command to the PTY. Watch out for the §5.10 startup-dialog
  rule (don't write into a TUI dialog) and note `/clear` resets the CLI
  conversation while our Feed keeps its derived blocks — decide whether
  clear also resets the Feed view (probably yes: re-derive from the
  post-clear transcript).
  *Done when:* `/` pops the list, arrow/enter selects, the composed command
  runs in the session; no popup when `/` is mid-sentence; `/clear` works
  from the Session tab and the Feed reflects the cleared conversation.

**E10 exit:** a user can run a whole coding turn — prompt, watch, approve —
without the Terminal tab even being VISIBLE; the turn reads like the VS Code
extension reference (clean blocks, expandable detail); Terminal stays one
toggle away and raw TUI states surface it explicitly. Litmus checked per
surface.

## E11 — Session Bus & context transfer (outline)

> **Transport decided 2026-07-26 (architecture review AR-P1-6): the Session Bus
> is stdio-only in v1.** §5.29 already preferred stdio; this closes it. Two
> reasons. (1) The HookListener *must* be HTTP — hook commands are separate
> processes — but the bus has no such constraint, and one stdio MCP server per
> session DELETES the DNS-rebinding / CSRF / origin-check class from Phase 2
> rather than hardening against it (Claude Code's stdio transport has no network
> exposure and needs no auth; security is process isolation, one server process
> per client). (2) Decisive: an MCP tool call carries **no ambient session
> identity**, and the bus must know which switchboard session is calling. With
> stdio that is free — one process per session, identity in argv/env at spawn.
> With HTTP we would be minting and rotating per-session tokens again, i.e.
> adding a transport in order to need the defence the transport created.
> HTTP/WebSocket is deferred to §5.27 (mobile companion), where it is genuinely
> unavoidable and §5.29's Origin-allowlist + pairing-token floor applies.
> DESIGN.md §5.4 and §5.29 amended to match. The `mcp` capability on the
> adapter contract (P2-E15-01) is how a non-Claude CLI declares whether it can
> take the bus at all.

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
- **Events v2 (§5.12, revised 2026-07-22).** The one-item-per-session /
  resolved-means-gone core shipped with the E10 fix round; v2 adds the
  mockup's filters (All · Needed · By-session), inline actions on events,
  the full §5.12 event catalog, and the **questions-queue placeholder**
  (a session's clarification questions render as an expandable list the
  operator returns to later — owner request 2026-07-22).
  **Inline permission decisions (owner request 2026-07-23):** a
  needs-permission event carries the SAME buttons as the approval bar —
  Allow · Allow all (this session) · Deny — decidable from the Events panel
  without focusing the card ("blind allow/deny"). Plumbing: the event needs
  the held requestId(s) attached (join `sessions:pendingPermissions` by live
  id, or enrich the event push in ipc.ts); decisions ride the existing
  `sessions:decidePermission` / `sessions:allowAllSession` IPC. Interim
  shipped 2026-07-23: uniform item heights + per-item dismiss ✕.
- **Per-session "notify when done" checkbox (§5.9, owner request
  2026-07-22).** Done-toasts opt-in per session; rides the rules engine.
  (Interim shipped: no OS toasts while the window is focused, crashes
  excepted.)
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
0. **(added 2026-07-26)** The seams are real: a second provider adapter could
   be written without editing `sessions/ipc.ts`, renderer contributions resolve
   through a registry with 4+ dissimilar consumers, every IPC channel carries a
   declared capability, and a theme is a JSON token map. (E15.)
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
are the daily pain" clause — plus the Session-tab pivot)** → E9-01/02/03
(merged) → **E15 (inserted 2026-07-26 by the architecture review: runs NEXT,
before the rest of E9 — E9-05 and E9-07 are hard-blocked on E15-08, and every
other E15 item is cheap now and an audit later)** → rest of E9 → E11 →
E13 after E11 (needs its context packages) → E14 interleaves anywhere after
E9 (actionable-toast slice pairs with E10's approval bar).

**Within E15**, the dependency order is: 01 (adapter) and 02 (registry) are
independent and can go in either order → 03 + 04 depend on 02 → 07 → 08 (which
unblocks E9-05/07) → 05 → 06. The standalone fixes (09 permission fail-open,
10 drift detector, 11 discovery I/O, 12 CSP, 13 migration hook, 14 perf
re-measure) have no dependencies and can be picked up any time — **09 is a live
defect** (a dead renderer stalls the CLI 300s per gated call) and is the best
candidate to take first if a short item is wanted.
