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
Structural foundations** · **E18 Stream-json transport migration** · E9
Attention-driven layout · E10 Approval surfaces v1 · E11 Session Bus & context
transfer · E12 Session groups & Feed view · E13 Dispatch v1 · E14 Notifications
v2, event feed v2 & service status. (E9–E14 work items get filed just-in-time as
the preceding epics near exit — per `00-process.md`, we do NOT bulk-file the
whole phase.)

> **E18 — the transport migration — runs NEXT, and it has its own plan file:
> `docs/plans/05-transport-migration.md` (planned 2026-08-01).** It is here
> rather than in E11 because the one thread tying them together was cut: S-09
> proved permission delegation rides the stream-json control channel, **not**
> MCP, so E11's deferred `mcp` capability is no longer its first customer. E18
> is about how we talk to the CLI; E11 is about sessions talking to each other.
> **E15's remaining items (#109, #110, #111) are parked behind E18**, not
> cancelled.

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

- **P2-E7-06 · Auto task labels from the CLI's own title — S (§5.11, §5.3,
  §5.26). [added 2026-07-30, owner request; issue #408 filed 2026-08-11]** A blank task label fills itself
  from the description Claude Code *already writes into its transcript* — the
  same thing the Claude Code VS Code extension puts in its tab text. E7-03
  shipped the user-typed label; this fills it when the user has not.
  **This costs no tokens and no model call**: `TranscriptWatcher` is already
  tailing the file, and the line is `{"type":"ai-title","aiTitle":"…"}` (verified
  2026-07-30 across 27 real transcripts in `~/.claude/projects/`, one of them
  this very design session — `"Add markdown and file preview feature"`).
  Deriving our own summary was the old §5.11 wording and is explicitly rejected:
  it would spend the user's subscription on chrome and reimplement what the CLI
  hands us (P7).
  Decisions already taken (owner, 2026-07-30 — do not re-litigate in the item):
  fills the **task label, never the title** · persist
  `labelSource: 'auto' | 'user'`, typing makes it the user's forever and
  **clearing the field reverts to auto** · while on auto it **keeps tracking,
  de-duped** · **no title means no label**, folder name stands.
  `titles` joins the §5.3 adapter capability object (E15-01) so a non-Claude
  adapter simply does not get labels — no Claude branch in shared code.
  *Done when:* a fresh session's blank label fills itself within a turn or two of
  the first prompt and matches the CLI's own title; typing a label pins it and no
  later `ai-title` overwrites it, across a restart; clearing that label lets auto
  take over again; a session whose transcript has **no** `ai-title` looks exactly
  as it does today (this is the fail-open case and it gets a test, because the
  key is undocumented and may be renamed or dropped by any CLI release); an
  adapter that does not declare `titles` starts no title watch at all; and
  **repeat titles cost nothing** — the CLI re-emits the settled value every turn
  (14 identical lines in a 171-line transcript), so the de-dupe is asserted with
  a repeat-heavy fixture, not assumed. Fixture note: capture a real transcript's
  `ai-title` lines rather than hand-writing them — including the observed
  revision (`"…preview windows"` → `"…preview feature"`) and a late-arriving case
  (observed at line 339 and line 510 of two transcripts, so "it shows up early"
  is not a property to rely on).
  *Also in scope, small:* the label rides into OS toast text (§5.9), which is the
  actual payoff at 7–8 sessions — "Add markdown and file preview feature needs
  your input" instead of three toasts all reading "Switchboard.ai". That puts a
  prompt-derived phrase on screen during a screen-share, so the auto-label
  preference must be switchable off, and toast text falls back to the title when
  it is (litmus #4).
  *(Depends: E15-01 for the capability object — which is the item in flight as
  #98, so this follows it closely. Nothing else. Per Dan's 2026-07-30 call it
  waits for E15 to finish, alongside E16; it is the smaller of the two.)*

**E7 exit:** a 5-session workspace reads at a glance — identity, live status,
cost, git, and plan progress — and the rail mirrors every card. Litmus
(PHILOSOPHY §4) checked on each visible surface. *(E7-01…05 shipped in PR #42;
**E7-06 filed as issue #408, 2026-08-11** — the epic is
otherwise merged, so this one item reopens it rather than starting an epic.
**E7-06 built 2026-08-11**: `titles` is a fifth §5.3 capability with a per-LINE
reader, `labelSource` rides the persisted card, and the off-switch landed as a
workspace setting + title-bar chip rather than a notification pref — both "as
built" notes are in DESIGN §5.11 and §5.3. Fixtures are REAL `ai-title` lines
copied out of `~/.claude/projects/`, in `src/main/transcripts/fixtures/`.)*

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
  *(DONE 2026-07-30. Shipped **four** capabilities, not §5.3's four: transcripts
  / hooks / resume / **trust**, with **mcp deferred to E11** — a capability with
  no implementation and no consumer is what AR-P2-13 had us delete. `trust` was
  found in review: writing Claude's `~/.claude.json` acceptance was
  unconditional for every provider. Decisions live in a pure
  `sessions/start-plan.ts`; DESIGN §5.3 carries an "as built" note. Also fixed
  on the way: a persisted card whose adapter is GONE now falls back to the
  default instead of being permanently unstartable, and the transcript watcher's
  pre-existing-file guard is per-root — it was seeded once from one root, so any
  second root was unguarded and a fresh session would have adopted an old
  conversation.)*
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
  **SHIPPED 2026-07-31 (#102).** All five met, and **four themes shipped, not
  three**: Dan asked for a softer high-contrast after seeing the first one, and
  `soft-contrast` cost one JSON file, one entry in `builtin-themes.ts` and one
  string — no code path, no test edited to accommodate it. That is the item's
  own claim, tested by someone who did not know it was being tested. It is held
  to the SAME measured contrast bars as high-contrast (body text 15:1 vs 21:1 —
  softer on purpose, still AAA), because "softer" must not become "worse".
  What shipped differs from the wording above in three ways, all recorded in DESIGN §5.20 "as built": a theme
  is a **base preset + overlay** (the presets keep empty maps, which is also
  what makes the first paint correct); the layer-2 semantic tokens became
  **overridable** (a contrast theme that cannot touch the status hues is
  decoration) while session accents stayed identity; and the map is **colors
  and shadows only**. The `theme` contribution point came WITH this item rather
  than after it — the registry existed, so it was ~20 lines, and it is the
  first data-only point (consumer count 5 → 6). Two guards worth knowing about
  before touching this area: `tokens.drift.test.ts` parses `tokens.css` and
  fails if the enumerated list drifts, and the same file asserts WCAG ratios
  computed from the JSON, so "high contrast" is a measured claim. A **token
  `kind`** (`color | shadow`) exists because a shadow token is concatenated
  into a shorthand at some call sites and `none` there makes the whole
  declaration invalid — that cost the rail's drop-target ring in the first
  draft and is now pinned by a unit test and an e2e.
- **P2-E15-06 · Renderer preference persistence — S (§5.25, AR-P0-3).**
  Theme and language move from `localStorage` to the `ui` blob. The workspace
  store already documents why localStorage is unsafe here — the packaged
  renderer's loopback origin changes port per launch, so it resets every run —
  which means **theme and language almost certainly reset on every launch of a
  packaged build today**. Verify first, then fix.
  *Done when:* an e2e against the BUILT app sets a non-default theme and
  language, relaunches, and both survive; dev behaviour unchanged.
  **SHIPPED 2026-07-31, folded into #102's PR.** It was not planned that way:
  Dan ran E15-05's hand-off list, and test 5 — "pick high contrast, quit,
  relaunch" — failed. Shipping a theme picker whose choice evaporates was not
  worth the tidiness of a separate PR, and the verification the item asks for
  had just happened in the most direct way available.
  **The bug was live and is now measured, not inferred:** launch 1 of the built
  app is served from `http://127.0.0.1:58814`, launch 2 from
  `http://127.0.0.1:57029` — a different ORIGIN, so a different localStorage,
  so the stored preference reads back `null` and the app resolves to the OS
  default. Both prefs moved to the `ui` blob (`uiGet`/`uiSet`), with the same
  one-time localStorage migration `autonomy` already had — which only ever
  finds anything in dev, where Vite's origin is stable and the old value is
  genuinely still there. `main.tsx` now awaits `loadUiState()` BEFORE
  `initI18n()` and the first render, which is what keeps both preferences
  synchronous at boot instead of arriving a frame late.
  **AR-P0-3 is fully closed** by this plus #102.
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
  **SHIPPED 2026-07-31.** Both halves, with three deliberate departures, all
  recorded as an "as built" note in DESIGN §5.26: the detector diffs a
  **declared key set** rather than re-serializing (measured — 75 top-level keys
  across 250 real transcripts, of which we consume 7, so "warn on anything we
  don't read" is ~50 warnings on the first session); it is scoped **per
  transcripts root**, since the watcher went provider-generic in E15-01 while
  this schema is Claude-shaped; and the binding half added a FOURTH state,
  because "waiting for transcript" turned out to be two different things —
  `searching` (normal, neutral) and `unbound` (a real failure, and the only one
  that looks like one). The load-bearing rule, found in review: `unbound` must
  rest on **positive evidence** (a turn that ran, or an unclaimable file), never
  on hook traffic alone — `SessionStart` fires at spawn, so the first draft
  turned every un-prompted card red 45 seconds after it opened.
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
- **P2-E15-14 · Re-measure S-07 on the real app — S (§6, AR-P2-11).**
  *(depends: **#117** — the `pty:attach` subscribe race must be fixed first; a
  load-dependent dropped-output bug would muddy exactly the numbers this item
  is measuring.)* The
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
- **P2-E15-15 · App version + build identity — S (#172, added 2026-08-02 at
  Dan's request). SHIPPED 2026-08-02.** During PR #163's hand-testing Dan twice tested a stale
  `out/` build of main and read its old bugs as the PR failing — a full
  diagnostic cycle spent answering "which build is this?". Dan's direction:
  a version number visible in the app, moving with the code. Mechanism
  (agreed 2026-08-02): the `package.json` semver is the human-bumped release
  number, and the build stamps **git SHA + branch + dirty flag + build time**
  into the app at build time (electron-vite `define`) — NOT a per-PR/per-
  build counter in a committed file, which would put a guaranteed merge
  conflict into every concurrently-open PR (the update-branch cascade of
  2026-08-02 would have conflicted three times over).
  *Done when:* the running app shows version + short SHA + branch + build
  time somewhere findable in ≤5s (About/status surface; title bar in
  non-main builds); a dirty working tree is marked; a hand-tester can
  confirm "am I running the branch I think I am?" without leaving the app;
  `docs/manual/` mentions where to look.
  *Shipped as:* `src/build/git-identity.ts` asks git at config load,
  `electron.vite.config.ts` `define`s the answer into all three targets,
  `src/shared/build-identity.ts` reads and formats it for main (window title)
  and the renderer (title-bar stamp → About panel, plus a palette command).
  A build-age field was added beyond the spec — it is the field that actually
  catches a stale `out/`.

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
  **Amended 2026-08-04 (Dan, reviewing PR #198): the shipped default is
  `always-visible`; auto-collapse and auto-hide are opt-in. See DESIGN §5.8.**
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
  per-session toggle or the terminal-handoff bar (re-labeled from
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
- **P2-E10-08 · Composer auto-grow by rendered height — S (§5.10; owner
  request 2026-08-11).** The composer sizes itself by counting hard newlines
  only — `rows={Math.min(6, ...draft.split('\n').length)}`
  (`FeedView.tsx:1047`) — so soft-wrapped text never grows the box: a pasted
  paragraph that wraps to five visual lines still shows as one or two rows,
  and even the nominal 6-row cap is reachable only via Shift+Enter. Grow by
  *measured rendered height* (scrollHeight-style auto-grow) instead, capped at
  **12 lines**, shrinking back as text is deleted, with an inner scrollbar
  past the cap. Layout guard: the composer bottom-docks with the options row
  and the approval bar above it — growth must push the feed up, not overlap
  either neighbor.
  *Done when:* a pasted single-line paragraph that wraps to ~8 visual lines
  shows all of them without scrolling; growth stops at 12 lines and scrolls
  within the box past that; deleting text shrinks it back down to one line;
  the options row / approval bar stay correctly docked at max height; a test
  pins wrap-based growth (not newline counting).

- **P2-E10-09 · Paste images into the composer — M (§5.10; owner request
  2026-08-13). [issue #475]** A clipboard bitmap (MS Paint, screenshots)
  pastes into the composer and the model actually sees it. Contract research
  against the VS Code extension FIRST (reference-implementations.md) — the
  wire mechanism is theirs, the affordance is ours. Full done-when in #475.
- **P2-E10-10 · Drag & drop files into the composer — M (§5.10; owner
  request 2026-08-13). [issue #476]** Any file — markdown, text, source,
  images — drops onto the composer and reaches the session; per-type
  behavior matches the extension. Shares the attachment affordance with
  E10-09 (serial track — same composer region). Full done-when in #476.
- **P2-E10-11 · Copy button on code in session output — S–M (§5.10; owner
  request 2026-08-13). [issue #477]** Fenced code + Bash IN/OUT in the
  Session view get the viewer's existing copy affordance (decorateCodeFences
  pattern; #465's forgery guard applies). Full done-when in #477.

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

## E14 — Notifications v2, event feed v2 & service status (milestone: Phase 2; expanded 2026-08-11 from the 2026-07-21 outline; issues #407 + #420–#425)

*Goal: the event pipeline becomes the app's nervous system — rules decide who
gets told what and how (§5.9), the Events surface gets smaller and more capable
(§5.12), and the status bar knows when the provider is having a day (§5.14).
Expanded at the 2026-08-11 /pm sitting (Dan picked E14 over E11). Ordering:
01 → 02 (the design gate reshapes the surface 02 builds on); 03 unlocks
04/05/06; 07 is independent and interleaves anywhere.*

Work items:

- **P2-E14-01 · Events panel rework: reclaim the column — M (§5.12, §5.8;
  owner request 2026-08-11). [issue #407, filed ahead of the epic]** Dan's
  verdict on the shipped panel: too large for what it does, and largely
  redundant — session cards, the rail, and the urgency strip already carry
  most of its signal. Today it is an always-visible fixed 220px right-hand
  `<aside>` (`EventsPanel.tsx:123`) that costs every layout mode horizontal
  space the session grid wants. Rework it smaller and/or relocated —
  candidate shapes: a slim strip across the top; a collapsed-by-default
  drawer with a badge/count button that expands on click; merging it into
  the urgency strip's surface. **Design gate: present 2–3 concrete options
  to Dan before building — the shape is deliberately undecided.** Whatever
  wins must keep the §5.12 core (one item per session, resolved-means-gone),
  keep the queue-ordering/Ctrl+Space contract legible (E9-03: the queue is
  the authority, this panel renders it), rehome the reconnect offer and
  update notice, and honor §5.8 keyboard-fail-open — collapsing chrome never
  removes capability. Interacts with 02 (inline decisions want a visible
  surface — a collapsed drawer changes that calculus) and may moot #268
  (reviewed-row opacity) if the row styling is rebuilt.
  *Done when:* the design gate ran and Dan picked; the chosen shape ships
  with the invariants above intact and the reclaimed space going to the grid.
- **P2-E14-02 · Events v2: filters, inline permission decisions, questions
  queue — M (§5.12, revised 2026-07-22). [issue #420]** *(depends: 01 — the
  surface's shape changes this item.)* Filters (All · Needed · By-session);
  **inline permission decisions (owner request 2026-07-23):** a
  needs-permission event carries the SAME buttons as the approval bar —
  Allow · Allow all (this session) · Deny — decidable without focusing the
  card ("blind allow/deny"). Plumbing: attach the held requestId(s) (join
  `sessions:pendingPermissions` by live id, or enrich the event push in
  ipc.ts); decisions ride the existing `sessions:decidePermission` /
  `sessions:allowAllSession` IPC. Plus the **questions-queue placeholder**
  (owner request 2026-07-22): a session's clarification questions render as
  an expandable list the operator returns to later. (Interim shipped
  2026-07-23: uniform item heights + per-item dismiss ✕.)
  *Done when:* a held permission is answered entirely from the Events
  surface with the card never focused; declining one session's request
  leaves another's held; filters work; a clarification renders as an
  expandable list item; e2e via the stream fake (coordinates with
  E18-14 / #416).
- **P2-E14-03 · Rules engine core + per-session "notify when done" — M
  (§5.9; owner request 2026-07-22). [issue #421]** `when [event] in
  [session | any] → [actions]` with visibility-aware conditions; rules
  persist in the workspace store. First consumer: the per-session
  "notify when done" checkbox — done-toasts opt-in per session. The interim
  behavior (no OS toasts while focused, crashes excepted) becomes a
  visibility condition, not a special case.
  *Done when:* a rule fires only when event, scope, and visibility all
  hold; the checkbox round-trips restart; evaluation is table-driven
  unit-tested; one rule proven e2e.
- **P2-E14-04 · Actionable Allow/Deny toasts — S (§5.9). [issue #422]**
  *(depends: 03)* OS toasts for needs-permission carry Allow / Deny riding
  the same decide IPC — one decision path, three surfaces (bar, Events,
  toast). Quiet when the window is focused.
  *Done when:* toast-Allow runs the held tool with the app unfocused; Deny
  refuses; a permission decided elsewhere withdraws its toast; a dead
  session's toast logs instead of throwing.
- **P2-E14-05 · Per-session sounds, TTS, quiet hours + digest — M (§5.9).
  [issue #423]** *(depends: 03)* Distinct per-session sounds; TTS speaking
  the task label (pairs with E7-06/#408, falls back to title); quiet hours;
  missed-events digest on return.
  *Done when:* two sessions ring distinguishably; TTS speaks the label;
  quiet hours suppress and the digest lists what was suppressed; all
  actions fail open — audio failure never delays the event.
- **P2-E14-06 · Phone push (ntfy/Pushover) + webhook — M (§5.9) [part
  user]. [issue #424]** *(depends: 03 + Dan's service pick)* Push and
  generic-webhook rule actions; credentials in the OS credential store
  (§5.29), never files.
  *Done when:* a rule pushes to a phone; the webhook payload is documented;
  the app runs fine unconfigured; delivery failure is fail-open and logged;
  secrets never hit logs or the workspace file.
- **P2-E14-07 · Status bar service health — M (§5.14). [issue #425]** *(no
  deps)* Anthropic Statuspage polling (status + unresolved incidents),
  status-bar dot + tooltip, incident Events entries, local corroboration
  banner (multiple sessions erroring → "possible provider issue" before the
  status page catches up).
  *Done when:* mocked responses drive dot/tooltip/entries through all
  states incl. unknown; the corroboration banner raises and clears; a
  polling failure never nags.

**E14 exit:** the Events surface earns its pixels (small, capable, decisions
inline), a session can reach you by sound, voice, toast, or phone — each
opt-in, each fail-open — and the status bar answers "is it me or is it them?"
Litmus (PHILOSOPHY §4) checked per surface.

---

## E16 — Document viewer v1: rendered markdown (milestone: Phase 2; added 2026-07-30, owner request; issues #409–#412 filed 2026-08-11)

*Goal: read what the agent wrote, in the app, rendered. Governing spec:
DESIGN.md §5.30 (written with this epic), plus §5.7, §5.10, §5.23, §5.29.*

**Why it is here and not Phase 3.** The full viewer belongs beside the §5.7 file
tree in Phase 3 — and that is where v2 sits. But the reading problem is a daily
one right now (`PROGRESS.md`, the plan files, findings notes, review reports are
all markdown written by an agent and read by a human who currently alt-tabs to
VS Code), and the cheap 80% of it needs **no new infrastructure**: `marked` and
`dompurify` are already dependencies rendering assistant prose in FeedView,
Monaco with its workers is already bundled for DiffPane, the `panel` contribution
point already exists, and popping a Dockview group into its own OS window is
E8's shipped `addPopoutGroup` path. Three items of glue, one new capability.
Phase 2 is overfull, so the scope is drawn tight on purpose — see *Not in scope*.

**Decisions taken up front** (owner, 2026-07-30 — recorded so the items don't
re-litigate them): rendered-by-default with a source toggle, defaulted **per file
type** · **one reusable peek slot, pin to keep**, not a tab per file · mermaid
**deferred** to a code fence (DESIGN §10 carries it with its CSP cost) ·
`fs.read` scoped to **open session folders plus user-picked paths**, nothing
wider · **read-only forever** (PHILOSOPHY §5's rejected-editor precedent).

Work items:

- **P2-E16-01 · Shared markdown renderer + the `fs.read` capability — M
  (§5.23, §5.29).** *(no deps)* Extract FeedView's inline `marked` + DOMPurify
  call ([`feed-blocks.tsx`](../../src/renderer/src/extensibility/feed-blocks.tsx))
  into one renderer-side markdown module with ONE sanitizer configuration, and
  give the viewer a way to read a file: a new `fs.read` capability in
  `shared/ipc/capabilities.ts` plus a broker-gated channel behind it. The scope
  check, the size cap, and the path-escape rejection all live in **main** — a
  renderer-side check protects nobody. `fs.probe` is not widened to cover this:
  existence-and-type is strictly less power than contents, and the whole point of
  the capability split is that a Phase-4 consumer can hold one without the other.
  *Done when:* FeedView renders through the shared module with no visual change
  and its existing tests green; a read of a path outside every open session
  folder and outside the dialog-picked set is refused and logged; `../`
  traversal and a symlink pointing out of the root are both refused; an
  over-cap file returns truncated-with-a-flag rather than hanging the bridge;
  the scope check has table-driven unit tests; the new channel appears in
  `CHANNEL_CAPABILITIES` (the untagged-channel test enforces it anyway).
- **P2-E16-02 · The viewer panel — M (§5.30).** *(depends: 01)* The document
  surface itself: header (file name, full path on hover, `Rendered | Source`
  toggle, Open externally, Reveal in folder, pin) and two bodies — rendered
  markdown, and Monaco read-only for source. Markdown scope for v1: GFM tables,
  task-list checkboxes, strikethrough, fenced code with language label + copy
  button, YAML front-matter chip, heading anchors + outline, relative-link
  navigation with back/forward, readable measure, wide tables scrolling in their
  own container, `webContents.findInPage` wired for Ctrl+F. Non-markdown text
  opens in source; anything binary or PDF gets the "open externally" card, not
  garbage. Opens from `Open file…` in the command palette and from a path click
  in the Changes tab's file list.
  *Done when:* a `.md` opens rendered by default and the toggle round-trips to
  source with scroll position kept; a `.ts` opens in highlighted source; a PDF
  and a binary each show the card; a remote `<img>` renders as a click-to-load
  chip and issues **no** network request (CSP `'self'` holds — assert it, don't
  assume it); an `http` link opens in the OS browser via `shell.openExternal`
  and a `javascript:` link does nothing at all; a markdown file containing
  `<script>` and an `onerror` attribute renders inert (sanitizer test with real
  hostile input, not a smoke test).
- **P2-E16-03 · Peek slot, pinning, and the viewer window — M (§5.30, §5.8).**
  *(depends: 02)* One reusable viewer whose content is replaced by the next
  glance; pin promotes it to a permanent tab and sends the next open to a fresh
  peek slot. The pop-out control opens it as its own OS window through E8's
  existing `addPopoutGroup` path. Session attribution when opened from a card:
  accent tint + `↳ session` chip (§5.24 convention). And the invariant that
  makes it safe: **a viewer never opens into a session's group**, and never
  appears in the sessions rail, the attention queue, or a bulk-close.
  *Done when:* opening a second file replaces the peek slot; pinning makes the
  next open a NEW panel; the viewer pops out to its own window and docks back;
  opening a file while a popped-out session group is focused puts the viewer in
  the document area rather than in that popout — **the E8-04 defect in mirror
  image, asserted in e2e, not reasoned about**; a viewer is absent from the rail,
  the queue, and bulk-close; closing the app with viewers open loses no session
  state.
- **P2-E16-04 · Live re-render — S (§5.30).** *(depends: 02)* Watch the open
  file and re-render on change, preserving scroll position. **This is the
  differentiator, not the polish** — the whole attention-ROI case for the epic is
  reading `PROGRESS.md` while an agent rewrites it, which is the one thing an
  external editor does badly. If the slice has to be cut, cut it last. Reuse the
  watch approach in `main/transcripts/watcher.ts` rather than inventing a second
  one; debounce, because an agent's write is often several writes.
  *Done when:* an external edit to the open file re-renders it within a beat with
  scroll position intact; a rapid burst of writes produces one re-render, not
  ten; deleting the file shows a "file is gone" strip instead of an error or a
  blank pane; the watch is torn down when the panel closes (asserted — a leaked
  watcher per opened file is exactly the kind of thing that only shows up at
  session 12).

**Not in scope — this is Phase 3's viewer v2** (DESIGN §8): the **Files** tab and
the §5.7 file tree · image / JSON / JSONL / CSV rendering beyond v1's
open-externally fallback · follow-tail for logs · restoring open viewers across
relaunch · mermaid · rendered-markdown diffs · anything that writes to a file.

**Sequencing:** 01 → 02 → 03 → 04. It slots after E15 and the rest of E9, and it
does not block or depend on E11/E13/E14 — a good candidate for a short slot
between heavier epics. **User doc:** `docs/manual/` page before the PR (the
`00-process.md` rule); this one is genuinely user-facing.

**Manual-test note for the hand-off:** the remote-image and hostile-markdown
cases are automated, so Dan's list should be the ones a machine reads wrong —
does a real doc *look right*, is the source toggle where the hand expects it,
does the viewer window land on the intended monitor.

---

## E17 — Session find (Ctrl+F) (milestone: Phase 2; added 2026-07-30, owner request; issues #413–#415 filed 2026-08-11)

*Goal: find a string in a session the way you find one in a browser. Governing
spec: DESIGN.md §5.31 (written with this epic), plus §5.10, §5.23.*

**Why it is worth its own epic.** The Claude Code VS Code extension does not have
this, and the gap is felt daily: two hours into a session you know the agent
printed a path, and there is no way to ask where. It is also **not** the
half-hour job it looks like, for one measured reason — searching what is rendered
would return "no results" for strings that are provably in the session.

**The measurement that shapes every item** (2026-07-30, three real transcripts in
`~/.claude/projects/c--Projects-Switchboard-ai/`): a 4,697-line transcript derives
**3,356 blocks / 1.2 MB of text**, against a `BLOCK_CAP` of **1,000**. About 70%
of a long session is already evicted from the renderer's view buffer, which is
working as designed — `watcher.ts` calls it "a view buffer, not an archive". So
the search engine reads the transcript FILE in main. A DOM search would ship a
confident lie, and a search tool that lies once is never trusted again.

**Decisions taken up front** (owner, 2026-07-30 — items must not re-litigate
them): one Ctrl+F covers the **whole session, results grouped by view** ·
it searches **everything including verbosity-hidden and folded content**, and
jumping expands the block · **hybrid presentation** — browser bar plus an
expandable results list with snippets · **per-session now**, with scope as an
engine parameter so §10's global search extends it rather than replacing it.

Work items:

- **P2-E17-01 · Transcript search engine in main — M (§5.31).** *(no deps)*
  Scan a session's transcript file and return block-anchored hits with context
  snippets. Case-insensitive by default; case-sensitive, whole-word and regex as
  options. Scope is a **parameter** (a session list), which is the entire seam
  §10's cross-session search needs. Reads through the existing
  `transcripts.read` capability — **no new capability**, unlike E16, because the
  file is one we already watch and already expose.
  *Done when:* searching the 4,697-line fixture returns hits in blocks the view
  buffer has evicted (that is the whole point — assert it explicitly against a
  captured real transcript, not a synthetic one); an uncompilable regex is
  reported as a bad pattern rather than thrown; a session with no transcript
  returns empty and does not error; searching a file being appended to right now
  neither misses the tail nor double-counts it; a 1.2 MB scan does not block the
  main thread long enough to stall a PTY (this is the thread that pumps every
  terminal — measure it, and chunk the read if it does).
- **P2-E17-02 · The find bar + `find-provider` seam — M (§5.31, §5.23).**
  *(depends: 01)* One bar, browser rhythm (Enter / Shift+Enter / count / Esc /
  sticky term across tab switches), dispatching to the FOCUSED panel's registered
  provider. Registrants day one: Session view (the 01 engine), Terminal (item
  03), the §5.30 document viewer, and Changes — which **delegates to Monaco's own
  find** rather than reimplementing it. Jumping to a hit expands folded or
  verbosity-hidden content.
  *Done when:* Ctrl+F searches the focused session and **never matches text in
  another card** — assert it with two cards containing the same string, because
  `webContents.findInPage` gets this wrong by design and is the obvious thing for
  someone to reach for later; Esc closes and returns focus where it was; a panel
  with no provider greys the bar instead of silently searching the wrong surface;
  four registrants exist and `extensibility.md`'s roster table is updated.
- **P2-E17-03 · Terminal search + grouped results — S (§5.31).**
  *(depends: 02)* `@xterm/addon-search` behind the Terminal's provider, plus the
  grouped count in the bar. **Check the version first:** 0.16.0 declares no peer
  dependency so it installs against our `@xterm/xterm@6.0.0`, but it predates
  xterm 6 and the 0.17 beta pins `^6.1.0-beta` — verify it actually works at
  runtime before building on it, and say so in the item's findings if it does not.
  *Done when:* a match in scrollback highlights and steps; the bar labels that
  group **"scrollback only"** so a 0 never implies absence (the terminal sees
  5,000 lines behind a byte-capped ring buffer, the transcript sees everything —
  one number over two depths would be a small lie that costs more than the
  feature earns); a term present only in the transcript still shows its Session
  count correctly.

**v1 boundary, recorded so nobody discovers it in review:** a hit in an evicted
block is **readable in the results list but not jump-to-able in place** —
in-place jump needs the watcher to derive a window of blocks around an arbitrary
transcript offset, which it cannot do today. v1 gives those hits a generous
snippet and marks them as earlier than the loaded view. On-demand block loading
is the named follow-up; it is a gap with a label on it, not a surprise.

**Not in scope:** cross-session / global search (§10 — this builds its engine,
not its result surface) · semantic or fuzzy matching · search inside the git
diff beyond delegating to Monaco · persisting search history.

**Sequencing:** after E16, or interleaved with it — E17-02's find bar and E16's
viewer both want the same bar component, so whichever ships second reuses it.
Neither blocks the other; if both are open, do E16 first so the viewer exists as
E17-02's fourth registrant rather than a promised one. **User doc:**
`docs/manual/` page before the PR.

---

## E19 — Release & auto-update (milestone: Phase 2; added 2026-08-05, owner request — issue #256)

*Goal: dogfooding builds that update themselves. The app checks for a new
release, shows a small "there's a new release" dialog with the release notes,
and one click downloads, verifies, and installs it. Reference implementation:
**ClaudeMon** (`C:\Projects\ClaudeMon`) — dissected 2026-08-05. It is C#/WinForms
+ Inno Setup, so it contributes **architecture and policy, not code**: the
single-version-source → build → sha256 → `gh release create` pipeline with
notes-required gating, the fail-open never-throws result contract, the
Get / Ignore / Skip-this-version prompt policy, and the opt-in silent install
with a pending-version handshake confirmed on next startup.*

**The one hard problem, decided up front** (orchestrator, 2026-08-05 —
veto-able in an issue comment, like the nordic-ink call): the repo is PRIVATE,
and ClaudeMon's anonymous `releases/latest` check gets a **404 on a private
repo — which its logic would misread as "no releases, you're up to date"
forever.** Decisions:

1. **Feed = this private repo's GitHub Releases; auth = a locally-resolved
   token, never embedded.** Resolution order at runtime: OS credential store
   (DESIGN.md §5.29's home for credentials) → `gh auth token` shell-out (zero
   setup on Dan's machines) → **disabled, silently** (fail-open: no token means
   no update checks, never an error dialog). ClaudeMon's own doctrine — "never
   embed a token in the shipped app" — is the argument against the shortcut.
   The alternative (a public releases-only repo) is rejected for v1: it makes a
   private product's installers world-downloadable.
2. **Hand-rolled checker over `electron-updater`.** electron-updater's private
   GitHub story needs the same token anyway, drags in `latest.yml`/blockmap
   machinery, and expects signed builds for its Windows flow; the ClaudeMon
   contract is smaller, proven, and fits the repo's broker/service idioms.
   electron-**builder** is still used for packaging (item 01) — just not its
   update runtime.
3. **Windows-only v1, unsigned.** Dogfooding is Windows. No code signing:
   per-user NSIS install avoids UAC, and the in-app download dodges SmartScreen
   because Mark-of-the-Web is applied by browsers, not raw HTTP clients
   (ClaudeMon's measured trick). sha256 verification does the integrity work;
   note it is TOFU — checksum and installer come from the same feed.
4. **OQ #6 (the app-name check) is NOT triggered** — private dogfood releases,
   not public distribution. It re-arms the day a release becomes public.
5. **404 handling is the opposite of ClaudeMon's:** on a private repo, 404
   means *missing/insufficient auth* and must be reported as such internally
   (still silent to the user on automatic checks) — never "up to date".

Work items:

- **P2-E19-01 · Packaging: electron-builder + Windows installer + version and
  changelog conventions — M.** *(no deps)* Add `electron-builder` (packaging
  only): productName/appId, per-user one-click NSIS target, `asarUnpack` for
  `node-pty` (the native dep is why this is not config-paste), a placeholder
  `.ico`, `npm run package` producing
  `dist/switchboard-Setup-<version>.exe`. Versioning: package.json semver stays
  the single human-bumped source (per `src/shared/build-identity.ts`'s
  documented split — semver = release number, git stamp = build identity);
  add `CHANGELOG.md` (with a section for the first release) and a bump
  convention. Known guardrails: `check-scripts.test.ts` asserts the ci.yml
  comment against package.json scripts; reuse `scripts/ev.js`'s env-stripping
  if spawning electron tooling.
  *Done when:* `npm run package` on Windows produces an installer that installs
  per-user **without UAC**, launches, and shows the right semver + git stamp in
  About; installing over a running instance completes (upgrade path); a PTY
  session starts in the packaged app (node-pty survived asar — this is the
  assertion that matters); `dist/` stays gitignored.
- **P2-E19-02 · Release publishing: tag-driven CI workflow + notes-required
  gate — S.** *(depends: 01)* `.github/workflows/release.yml` on tag `v*` (+
  `workflow_dispatch` for dry runs): windows-latest, `npm ci`, lint + typecheck
  + unit gate, package, sha256 sidecar, create the GitHub Release on this repo
  with notes extracted from `CHANGELOG.md`. ClaudeMon's two publish-script
  rules carry over verbatim: **hard-fail if the version has no changelog
  section** (an empty release is one the updater will offer to every user),
  and roll never-published older sections into the notes. Tag must equal
  package.json version or the workflow fails.
  *Done when:* pushing a `v*` tag yields a release with installer + `.sha256` +
  changelog-derived notes; a tag with no changelog section fails loudly; a
  re-run on an existing release is idempotent, not a duplicate; the existing
  5-job CI is untouched.
- **P2-E19-03 · Update check + "new release" dialog with in-app notes — M.**
  *(depends: 02)* Main service (the `preflight.ts` shape: one broker-handled
  probe returning a plain result object): checks `releases/latest` with the
  decided token resolution, result-record pattern, **nothing in the update path
  throws**. Startup check + 24h timer + manual "Check for updates…" (palette,
  menu, About panel). New capability pair in `CHANNEL_CAPABILITIES` (named for
  what they DO, per the `environment.probe` precedent); preload namespace
  `update: { check(), onStatus(cb) }`. Renderer dialog follows AboutPanel
  (role=dialog, Escape/click-away, focus return, joins the `modalOpenRef`
  latch): "There's a new release — vX" with **Update / Ignore / Skip this
  version** and the **release notes rendered in-app** (the release body; E16's
  shared markdown renderer). Skip is per-version; a manual check always
  prompts, even for a skipped version. Settings toggle for auto-check
  (default on). i18n for all renderer strings.
  *Done when:* with a newer release published the dialog shows version + notes;
  Skip suppresses exactly that version and a newer release prompts again; with
  **no token the app behaves identically to today** (no dialog, no error, one
  debug log line); automatic-check failures are silent, manual-check failure
  shows a gentle non-error message; version compare handles `v`-prefix and
  3-vs-4-part forms (unit-tested); the 404-means-auth case is distinguished
  from "no releases" (unit-tested); user doc page in `docs/manual/`.
- **P2-E19-04 · One-click download + verified install + post-update
  handshake — M.** *(depends: 03)* Download the installer asset to temp over
  authenticated HTTPS (GitHub private-asset download: `Accept:
  application/octet-stream`, token on the API host **but never forwarded to
  the signed redirect host**), determinate progress + cancel in the dialog,
  verify against the `.sha256` sidecar — **mismatch deletes the file and never
  executes it** (fallback: open the release page in the browser). Launch the
  NSIS installer silently, quit the app, persist `pendingUpdateVersion`; next
  startup compares it to the running version and surfaces "You're now on vX"
  (event feed), or logs a warning on mismatch. Stale temp installers swept at
  startup; re-entrancy guarded (a timer tick during a download must not
  double-prompt); absolute-HTTPS-only for anything executed or opened.
  *Done when:* Update on a real (draft) release downloads with progress,
  verifies, silently installs, relaunches the new version, and the new run
  confirms the handshake; a corrupted download is deleted, never executed, and
  falls back to the browser path; cancel mid-download works and the persistent
  "update available" affordance remains; every failure path is fail-open.

**Not in scope:** macOS/Linux packaging (the release workflow's shape mirrors
CI's matrix when they matter) · code signing / notarization · delta updates ·
channels/prereleases beyond GitHub's own `latest` semantics (drafts stay the
staging mechanism) · auto-install-without-asking (the dialog is the consent).

**Sequencing:** strictly serial, 01 → 02 → 03 → 04 — each item's gate needs the
previous item's artifact (02 packages 01's installer; 03 checks against 02's
release; 04 installs what 03 found). **User doc:** the manual page arrives with
03 and is extended by 04. PHILOSOPHY §4: this is orchestrator-owned app
infrastructure, not an AI-session feature — the litmus items on session
authority don't bite; fail-open and local-first are the binding constraints
(the check talks to the release host and nothing else, and a dead feed never
blocks a session).

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
7. **(added 2026-07-30)** A markdown file an agent just wrote can be read
   *rendered* in the app — in a pane or its own window — with its source one
   click away, and nobody alt-tabs to VS Code to read `PROGRESS.md`. (E16.)
8. Litmus test passes on everything shipped.

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

**Three items added 2026-07-30**, all user-facing, none blocking anything:
**E7-06** (auto task labels), **E16** (document viewer) and **E17** (session
find). They pair well — one makes sessions tell you what they are, one makes what
they wrote readable, one makes it findable. E16 and E17 share a find-bar
component, so run E16 first and E17 inherits both the bar and a fourth find
provider. None is filed as an issue yet, and **all wait for E15**: Dan closed the
E15-vs-E9 fork on 2026-07-30 with *finish E15, then E16, then the rest*. That is
also the technically convenient order — E7-06 wants E15-01's capability object,
and E16 registers against E15-03's `panel` point and E15-04's capability broker,
so both are glue over seams E15 is finishing rather than groundwork of their own.
E7-06 is the smaller of the two and the natural warm-up.

**Within E15**, the dependency order is: 01 (adapter) and 02 (registry) are
independent and can go in either order → 03 + 04 depend on 02 → 07 → 08 (which
unblocks E9-05/07) → 05 → 06. The standalone fixes (09 permission fail-open,
10 drift detector, 11 discovery I/O, 12 CSP, 13 migration hook, 14 perf
re-measure) have no dependencies and can be picked up any time — **09 is a live
defect** (a dead renderer stalls the CLI 300s per gated call) and is the best
candidate to take first if a short item is wanted. *(09 is done, PR #113.)*

**Scheduled alongside E15: #117** (2026-07-29) — terminal output lost in the
gap between `pty:attach` returning and the renderer subscribing. Not an E15
item; a pre-existing live defect found during #101's review. It is **a hard
prerequisite for 14 (#111)** and otherwise independent, so it takes the slot
after 08 (#105): 08 is the item that unblocks E9, #117 is the one that must not
be left sitting when 14 measures. Fix direction, per the issue: register the
renderer's `pty:data` listener **before** invoking `pty:attach`, so the
snapshot only ever returns to a subscriber that is already listening — that
removes the window rather than narrowing it.
*(#117 DONE 2026-07-30. Subscribe-before-invoke as planned, plus two things the
issue did not foresee: the gap chunks must be **buffered and replayed after**
the snapshot, since they are newer than it; and the wire needed an **epoch**
(`pty:attach` → `{epoch, snapshot}`, `pty:data:<id>` → `{epoch, d}`), because
subscribing first also lets a chunk from a PREVIOUS attach reach the new
listener — which would trade the silent loss for duplicated output. Sequencing
lives in `renderer/src/lib/terminal-attach.ts`; contract in
`shared/ipc/pty.ts`. **#111 is unblocked.**)*
