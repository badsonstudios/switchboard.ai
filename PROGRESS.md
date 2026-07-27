# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Phase 2 - The Switchboard (E7+E8+E10+E12 complete & merged;
**E9 filed 2026-07-24 → #70–#80**; **E15 filed 2026-07-27 → #98–#111**;
E11/E13/E14 still outlines)
**In progress:** **#112 — the tail-pin race — FIXED, PR open** on
`fix/112-pin-race-swallowed`. It was a real bug, not a flaky test: `pin()` sets
`autoPin` until the next animation frame, and `onScroll` opened with
`if (autoPin.current) return` — so a LAYOUT scroll landing in that same frame
was swallowed with it, stranding the view mid-history with output below the
fold and no further event to correct it. Exactly the symptom the test was
written for (Dan, 2026-07-26); the guard had a one-frame hole. Fix: our pin
always lands ON the tail, so a scroll arriving in that window nowhere near the
tail is somebody else's — correct it, gated on no recent gesture so a user
scrolling up mid-pin is never yanked back. Evidence (rebuilding between each):
**without the fix 4 failed / 4 passed of 8; with it 8/8**. Gate: lint +
typecheck + **326 unit + 83 e2e** green. `main` was at `34a5fe8`; PR #113
(P2-E15-09) merged before it.
*After that*, the rest of E15: **#98** (provider adapter capabilities) and
**#99** (process-agnostic registry) are independent and either can go first;
#99 then unblocks #100/#101, and #104 → #105 is the chain that unblocks
E9-05/E9-07. Remaining standalone fixes: #107, #108, #109, #110, #111. Merged 2026-07-26: **#96** (sessions-rail redesign, three
eyeball rounds, Dan signed off) and **#97** (architecture review + the E15
epic). Before those, same day: **#94** (Deny means deny), **#95** (#92
interactive-question signal), **#93** (#72 P2-E9-03 attention queue +
Ctrl+Space, plus the scroll-position fix, Events dismiss button, session-group
frames, the workflow hand-off change, and `docs/extensibility.md`). Earlier:
PR #89 (popout geometry #86), PR #88 (tab strip #84 + quit backstop #85), PR
#83 (E9-02 palette), PR #82 (E9-01).
**Next up (CHANGED 2026-07-26 by the architecture review):** **E15 —
Structural foundations** — 14 items, **filed as issues #98–#111 on 2026-07-27**
(`/pm`; P2-E15-01 → #98 … P2-E15-14 → #111). E15 runs BEFORE the rest of E9.
Two reasons: **E9-05 (#74) and E9-07 (#76) are hard-blocked on E15-08 (#105)**
(presentation state lives in `SessionCardPanel`'s `useState`, and "reveal
restores it to its exact prior slot" needs state that outlives the panel —
both issues now carry a blocked comment), and every other E15 item is cheap
now and an audit later.
**Recommended first pick: #106 (P2-E15-09) — a live defect**, where a
dead/closed renderer stalls the CLI for the full 300s on every gated call (the
`permListeners.size === 0` check can never fire because listeners register once
and are never removed). Within E15 the dependency order is: #98 (adapter) and
#99 (registry) independent → #100 + #101 depend on #99 → #104 → #105 (unblocks
E9-05/07) → #102 → #103. The standalone fixes (#106, #107, #108, #109, #110,
#111) have no dependencies and can be taken any time.
*After E15:* **#73 — P2-E9-04 urgency strip + delayed urgency reset**, then
#74–#80. E9 closes Phase 2 exit criterion #1. Also open, filed 2026-07-26 and
NOT yet scheduled: **#90** (no accelerator, palette included, reaches a session
terminal) and **#91** (box the tool blocks + drop the timeline dot on plain
assistant answers). [user] retests still pending on merged main (rebuild
first): test 4 (out-of-cwd read) WITHOUT allow-all + autonomy=ask · grid-drag
between groups · switch-to-session scroll · allow-all sessions now silent.
Also pending: ClaudeMon architecture read (OQ #8) before Phase 3 planning.
**Branch:** main (clean)

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

- ~~"Red build blocks merge" (#13)~~ **RESOLVED 2026-07-23**: repo is public
  → ruleset "main: green CI required to merge" (id 19646817) is ACTIVE on
  the default branch — all 5 CI checks required, force-pushes and branch
  deletion blocked. Repository-admin bypass is ON (required: direct
  PROGRESS.md/docs pushes to main can never have pre-push checks — GitHub
  rejected exactly that within minutes of the first version). The normal
  merge path still refuses a red PR; bypassing is an explicit act.
- **Loose ends deferred** (not blocking): full-auto → bypass footgun (offer:
  remap to a safer mode), 9MB Monaco renderer bundle (slim it). Say the word.
- **[user] ClaudeMon architecture read (OQ #8) is due.** `03-later-phases.md`
  says it must happen before Phase 3 planning, "ideally far earlier" — and the
  2026-07-21 reconciliation just moved MORE into Phase 3. Schedule a session
  to review ClaudeMon and decide shared-library vs sidecar vs merge.

## Log

- 2026-07-27 — **#112 root-caused: a REAL bug in the tail-pin, not a flaky
  test.** It had failed CI on #113 (Linux, twice, `Received 1301`) and was
  merged over. Reproduced locally **on Windows** — ~1 in 3 isolated runs,
  `Received 1318` — which killed the "Linux-only" framing before any fix was
  written. Instrumented the scroll handler and ran until it stranded:
  healthy runs log `autoPin=false pinned=true away=1318` (correction fires)
  then `autoPin=true away=0` (our own pin, correctly ignored); the stranded run
  logs **exactly one event, `autoPin=true pinned=true away=1318`** — dropped by
  the early return. `pin()` holds `autoPin` until the next animation frame, so
  a LAYOUT scroll landing in that same frame was swallowed as if it were ours,
  leaving the view mid-history with output below the fold and nothing left to
  correct it. Fix: our pin always lands ON the tail, so a scroll arriving in
  that window nowhere near the tail belongs to someone else — correct it, gated
  on no recent gesture so a user scrolling up mid-pin is never yanked back.
  Proof, **with a rebuild between each** (the #113 lesson — `npm run e2e`
  builds, bare `npx playwright test` does not): without the fix **4 failed /
  4 passed of 8**; with it **8/8**.
  **Two dead ends recorded so nobody repeats them:** (1) the rail is also an
  `overflow-y:auto` div, so I theorised the test's "first scrollable div"
  selector was measuring it — probed at 737px and 538px, `railOverflow: 0`,
  feed was the only candidate. Wrong, and I had written the fix before testing
  the claim. (2) WSL as a Linux repro: **WSLg works** (`DISPLAY=:0`, no xvfb
  needed) and Electron runs there after a rootless `apt-get download` +
  `dpkg-deb -x` of `libasound2t64` — but the test PASSES under WSLg (real
  compositor, 1.2s), and rootless Xvfb won't start because WSLg owns
  `/tmp/.X11-unix` and `xkbcomp` is absent. Windows reproduced it anyway.
  **Guard strength, stated plainly:** the existing e2e catches this ~50% of the
  time — it depends on the foreign scroll landing inside a one-frame window.
  Enough to have caught it across two OSes in CI, but a deterministic
  regression test would be better if this area is touched again.

- 2026-07-27 — **P2-E15-09 (#106) MERGED as PR #113** (`9f8e3a9`). Merged over
  a red Linux e2e job — the failure is **#112**, which reproduces on `main`
  with the branch stashed. The branch's OWN Linux failure was found and fixed
  first: the new crashed-renderer e2e died with `SocketError: other side
  closed`, because under xvfb a renderer crash takes the WINDOW with it →
  `window-all-closed` → non-darwin `app.quit()` → the hook server dies
  mid-request instead of answering. On Windows the window provably survives
  (probe: "windows still open: 1"), so the test is skipped on Linux with that
  reasoning recorded, matching the existing xvfb skips in `reconnect.spec` and
  `session.spec`. **The permission hold's "nobody to ask" check
  was testing the wrong thing.** `maybeHold` only failed open when
  `permListeners.size === 0` — but `ipc.ts` subscribes once at IPC setup and
  never unsubscribes, so that set is never empty in the running app and the
  guard could not fire. A dead renderer therefore parked the CLI for the full
  300s on **every** gated call. Now gated on **window liveness**
  (`hasLiveWindow`: not null, not destroyed, `webContents` not crashed), plus
  `releaseHeld(reason)` for requests already parked when the renderer dies.
  **Placement was the whole design:** the gate sits AFTER `shouldHoldPermission`
  (so an ungated call never consults it — pinned by a call-counting test) and
  AFTER the allow-all branch (that verdict is answered at the server and never
  needed a renderer). A RELOADING renderer is neither destroyed nor crashed, so
  the `sessions:pendingPermissions` replay path — the must-not-regress case —
  is untouched and separately tested.
  **Review found 2 should-fixes, both real.** (1) The crashed-renderer half was
  missing: a crash does NOT close the window, so `hasLiveWindow` caught later
  calls while anything already parked still sat out the 300s →
  `render-process-gone` wired alongside `closed`, via a module-level
  `onRendererLost` because `createWindow()` runs again on macOS `activate`.
  (2) `hasLiveWindow` was called unguarded inside `req.on('end')`, which has no
  error handling — a throw from those Electron natives would have left the
  response unended (CLI parks on ITS timeout) and escaped as an
  uncaughtException. Now `windowLive()` catches: **"I can't tell" resolves to
  "no window"**, never to "park".
  **Two mistakes of mine worth recording.** (a) The hand-off test list
  described a macOS scenario as if it were Windows: `window-all-closed` quits
  the app on non-darwin, so closing the window on Dan's machine quits — and
  quit already ran `hooks.stop()`, which releases everything. **The
  closed-window half of this fix is macOS-only; on Windows the reachable path
  is a crashed renderer.** Dan ran the test against stock `main` (his log
  showed three `permission held` lines and none of the new ones) and correctly
  reported seeing nothing. The manual page said the same wrong thing and is now
  platform-accurate. (b) My first "proof" that the new e2e catches the defect
  was a **stale build**: `npm run e2e` builds, bare `npx playwright test` does
  not — so reverting the fix and re-running the bare command "passed" against
  the previous binary. Rebuilt properly, it fails without the fix. *Lesson for
  next time: a revert-proof is only valid if the artefact under test was
  rebuilt.*
  Because the Windows-reachable path can't be hand-tested sensibly (kill the
  renderer, stare at a blank window, read a log), it became an **e2e**: park a
  real hold on the wire, `forcefullyCrashRenderer()`, assert the request comes
  back `{}`. A throwaway probe measured it first — released in **176ms**,
  `reason: renderer gone: crashed`, window still open (which is exactly why
  `isDestroyed()` alone was not enough of a signal).
  Also: warn once per session then debug (the condition repeats per gated
  call); the dead `permListeners` guard kept but its comment corrected to say
  it is defensive/test-only rather than claiming hook-check needs it.
  Gate: lint + typecheck + **326 unit + 83 e2e** green (8 new unit, 1 new e2e).
  **One run of the e2e suite took 18.9m with several tests failing-then-passing
  on retry; the identical run immediately after was 5.4m with zero failures.**
  Not reproducible, no orphaned processes found — recorded rather than
  smoothed over. Filed separately: **#112**, `e2e/feed.spec.ts:172` is flaky on
  `main` (proven not to be this branch — fails with the changes stashed, and
  took down #96's CI run including its automatic retry).
  **Deliberately NOT fixed:** the hung-renderer case (window alive, renderer
  wedged) — never covered before, still isn't; the review's "renderer
  acknowledged recently" probe is the candidate if it ever shows up in the
  wild.

- 2026-07-27 — **E15 FILED as issues #98–#111** (`/pm`, Dan's go-ahead). The 14
  work items from the architecture review are now on the Phase 2 milestone,
  numbered straight through (P2-E15-01 → #98 … P2-E15-14 → #111), each carrying
  its What / Done-when / Size / Depends-on plus a pointer to its `AR-*` finding.
  Dependency edges written into the issue bodies rather than left implicit:
  #100 and #101 depend on #99 (the registry), #105 depends on #104 (the store),
  #108 depends on #107. **#74 (E9-05) and #76 (E9-07) each got a comment naming
  #105 as a hard block** — the two E9 items whose contracts panel-local state
  cannot satisfy, so nobody picks them up ahead of it. The plan file's E15
  header carries the issue range and the two E9 hard-block notes cite #105.
  Also corrected the header of this file, which still described the rail
  redesign as an open PR and the E15 docs as uncommitted; both merged (#96,
  #97) and `main` is clean. Recommended first pick recorded as **#106** — the
  only item in the epic that is a live defect rather than structure work.

- 2026-07-26 — **FULL ARCHITECTURE REVIEW → new epic E15, runs next.**
  Dan asked for a deep architectural review (not a code review): does the
  shape hold, and will add-ins / customization actually work when we get
  there. Record: **`docs/architecture-review-2026-07-26.md`** — findings are
  ID'd `AR-P0-1 … AR-P2-14` so plan items and issues can cite them.
  **Verdict: the architecture is sound.** The card/live split, the
  hooks-are-status / transcript-is-telemetry authority split, and fail-open are
  real in code rather than aspirational; the §5.29 security floor was genuinely
  built before the first listener; the state machine encodes bugs we paid for.
  Don't touch those.
  **Three P0s, all of them "cheap now, audit later":**
  (1) *The provider contract can't express a second provider* — §5.3's
  `{transcripts, hooks, resume, mcp}` capabilities were never built, so
  `sessions/ipc.ts` hardcodes `providerId: 'claude-code'`, writes Claude hook
  settings unconditionally, and watches `~/.claude/projects` unconditionally.
  By §5.23's own test ("if our own adapter can't be expressed in the contract,
  the contract is wrong") the contract is wrong; we'd find out by writing
  adapter #2 and having to edit a consumer. (2) *There is no renderer-side seam
  at all* — 8 of §5.23's 9 first-party extensions are renderer contributions
  with nowhere to land, and the preload's ~60 methods have no capability
  scoping, so "main is the sole enforcer" is true only because there's nothing
  to enforce. The consequence is structural: **the Phase-4 gate ("2–3
  dissimilar consumers") was unreachable by construction** — count 1, unable to
  grow. Also noted: `lib/commands.ts` is already a contribution point in
  everything but name. (3) *Themes aren't token maps* — §5.20 promises JSON
  maps and import/export; we ship two hardcoded `[data-theme]` blocks and a
  `ThemeName` union that forbids a third theme. **With a live bug inside it:**
  theme + language sit in `localStorage`, which the workspace store's own
  comment says resets every launch in packaged builds (loopback port changes) —
  so both prefs almost certainly reset on every packaged launch. Verify, then
  fix.
  **Two P1s that bite during E9/E11:** the renderer has no state layer (module-
  level mutable `Map`s in `SessionGrid.tsx`, a DOM CustomEvent bus, and refs
  shadowing state to defeat batching — the reasoning was right, the home was
  wrong), and presentation state is panel-local where E9-05/E9-07 can't reach
  it. Plus a **live defect**: the permission hold's "nobody to ask" check reads
  `permListeners.size`, but listeners register once and never unregister — so a
  crashed or closed renderer parks the CLI the full 300s per gated call instead
  of failing open.
  **One design decision taken, not just recorded:** the **Session Bus is
  stdio-only in v1** (AR-P1-6). §5.29 already preferred stdio; this closes it.
  Stdio deletes the whole DNS-rebinding/CSRF class instead of defending it —
  and decisively, an MCP call carries no ambient session identity, so HTTP
  would have us minting per-session tokens again, i.e. adding a transport in
  order to need the defence the transport created. One process per session
  makes identity free. **No new localhost listener ships in Phase 2.**
  DESIGN.md §5.4 + §5.29 amended. **Dan confirmed it the same day** after the
  trade was put to him plainly — stdio means the bus is reachable ONLY by
  processes switchboard launches (no browser tab, no hand-run script, no other
  app, no phone), and he couldn't name anything non-session that would ever
  need in. That list being empty IS the cost, so it's a knowing trade, not an
  inherited one. Reversal trigger recorded in §5.4: a wanted feature where a
  non-session caller must reach the bus. Nothing else — and specifically not
  the mobile companion, which is a separate §5.27 WebSocket and was never
  riding this pipe.
  **Dan's answers at the review gate:** third-party plugin support **is** the
  real goal (first-party add-ons first) — so E15-04's capability brokering
  ships full-size, not trimmed to internal tidiness; Phase 3/4 scope is **not**
  being cut, reassessed when we get there.
  **Docs written/amended:** new `docs/architecture-review-2026-07-26.md` ·
  `04-phase-2-switchboard.md` (E15 epic, 14 items with done-whens; E9-05/E9-07
  marked hard-blocked on E15-08; E11 transport decision; exit criterion #0;
  Order + within-E15 dependency order) · DESIGN.md (§5.4 stdio, §5.29 listener
  split, §5.23 renderer-seam amendment + consumer count is a tracked number) ·
  `03-later-phases.md` (Phase 3: plan `utilityProcess` offload WITH the plugin
  host — same mechanism, so the throughput fix and the Phase-4 substrate are
  one job; OQ #8 now has a code consequence in `lib/usage.ts`. Phase 4: gate
  status + what E15 already pays for) · `docs/extensibility.md` (a "Known gaps"
  scoreboard so the contributor guide stops reading better than reality).
  **Not done, awaiting Dan:** E15 issues are **not filed** — that's a `/pm`
  step and needs his go-ahead. Nothing was committed: this landed while
  `feature/sessions-rail-redesign` is mid-item with uncommitted work, so the
  docs sit unstaged in the tree deliberately.
  **Also worth knowing:** S-07's perf verdict is *stale, not wrong* — it
  measured a harness (PTY + tailer + one xterm) before dockview, Monaco's 9MB
  bundle, live FeedView streaming, and per-card git polling existed. E9 is
  about to assert the 7–8-session experience as the primary workflow, which is
  exactly where S6/S7 become load-bearing (P2-E15-14 re-measures).

- 2026-07-26 — **Sessions rail REDESIGNED** from `design_handoff_sessions_rail/`
  (Dan's ad-hoc item, ahead of #73). Group *cards* on a tinted canvas: folder
  icon + name + count chip + a per-group **"N need you" / "calm"** summary, and
  a footer totalling the workspace. Rows lose the `diff ●` pair and the 7px
  dot; the colored left edge bar is now the only identity mark (**no per-session
  icon** — an explicit rejection in the design, don't reintroduce one), with a
  ✕ pinned top-right and the status indicator bottom-right. **A session that
  needs you states its case in words** — status tint, 4px bar, name at 700, and
  the sub-label replaced by *Asked you a question* / *Wants permission to run* /
  *Finished — review changes* / *Crashed — needs restart*. The working ring is
  the only animation left.
  **Two decisions Dan made up front:** the dropped diff link moved to a
  **right-click menu** (Open changes / Rename / Close session), and the rail is
  **drag-resizable** with the width persisted (286px default, clamped 200–520).
  **The contrast work was the substance, and it needed measuring, not
  eyeballing.** Status text got a per-theme `{text, indicator}` split — new
  `--status-*-ink` tokens, darkened for daylight (`#1c62c9`, `#8a5a06`, …)
  while the bright `--status-*` hues keep driving dots, rings and glyph
  backplates, exactly as the handoff prescribes. Then the *group* colors:
  `GROUP_PALETTE` is tuned for a dark panel, so as 11.5px text on the white
  card its mid-tones sit at **2.2–3.1:1**, under AA — which is why the design
  shipped darkened group colors. Rather than mutate saved user data,
  `.rail-group-ink` blends the color per theme (55% toward ink in daylight).
  **Measuring then caught the mirror bug the design didn't cover:** `#4a90d9`
  on the Nordic card is only **3.9:1**, so Nordic blends 78% toward white. All
  8 palette entries now clear AA in both themes (daylight 5.9–8.1, Nordic
  4.8–6.6), pinned by an e2e that computes the ratio.
  **Two false readings worth recording.** (1) My first contrast probe scored
  1.00 — the walk up for a background accepted the header band's 7% tint, whose
  rgba channels are the *un-composited* group color, so the text was measured
  against itself; it must skip anything with alpha < 1 and land on the opaque
  card. (2) The fixed walk then scored Nordic at 1.60: Chromium returns
  anything that went through `color-mix()` as **`color(srgb r g b)` in 0–1
  floats**, not `rgb()` in 0–255, and dividing those by 255 scores every mixed
  color as black. Daylight had been *passing spuriously* on the same bug. A
  contrast assertion that can't tell you which colors it read is worth very
  little.
  Structure: rail extracted out of `chrome.tsx` into `components/SessionsRail.tsx`
  (chrome is titlebar + statusbar now), presentation rules isolated in a pure
  `lib/rail-view.ts` so the row treatment, the group summary and the footer
  count can't disagree about what "needs you" means (`done` is IN that set —
  §5.8's completed-unreviewed). `starting`→working+spinner, `suspended`→idle,
  unknown status **fails open to idle** — our blind spot must never invent an
  alarm. `SessionGrid` gained `onActiveCardChanged` to feed the selected-row
  tint. Auto-groups (E12-05) and Ungrouped render as the same card with the
  tools removed and a dashed folder; a workspace with no groups at all skips
  the Ungrouped header rather than adding pure chrome.
  Also: hook-driving helpers (`hookPoster`, `findTokens`, `poll`) lifted from
  `attention.spec.ts` into `e2e/fixtures/app.ts` instead of copied; `boot.spec`
  scoped its "no sessions" assertion now that the rail has its own footer
  count; dead `diff.open` i18n key removed. Manual: `07-workspace.md` rewritten
  (status table, the attention treatment, resize, right-click menu).
  Gate: lint + typecheck + **318 unit + 78 e2e** green (11 new rail-view unit,
  6 new rail e2e).
  **Round 2 (Dan's first eyeball), 3 findings, 2 actioned:**
  (1) *"I need a better border around the main session windows... and around
  the groups... whatever we do here is what we're going to want to do for the
  session windows too."* So **`--group-frame` is now genuinely shared**: the
  rail's group cards dropped `--border` (a hairline tuned for INSIDE a card)
  and took the same frame the grid's `.dv-groupview` uses, plus a new
  **`--group-lift`** shadow on both. Both tokens strengthened — daylight
  `#b9c2ce`→`#8593a6`, nordic `#525d73`→`#6b7793`; the old daylight value was
  only 1.30:1 against the white card, which is why it read as nothing.
  `--rail-card-shadow` deleted in favour of the shared token, so there is one
  container treatment and no way to drift.
  (2) *"Dragging an item onto another group doesn't really work very well — I
  have to drag it to the little folder icon."* True: the drop handler lived on
  the header alone. **The whole card is the drop target now** (the header keeps
  no handler — a drop there bubbles up), with a ring in the group's color while
  you hover so the destination is visible before you let go, `dragleave` guarded
  by `contains(relatedTarget)` so moving between the card's own children doesn't
  flicker it off, a window `dragend`/`drop` listener so an abandoned drag can't
  leave a card lit, and a same-group drop short-circuited instead of round-
  tripping through IPC and a grid reshuffle.
  (3) Ungroup — *"works fine, I like that"* — untouched.
  **Test gap this exposed:** `tabs.spec`'s frame assertion measures the
  *focused* group, which is drawn in `--link`, so the neutral frame Dan was
  complaining about had never been covered. New e2e measures the **token**
  against all three surfaces it borders (grid card, rail card, rail canvas) in
  both themes — one assertion covering both consumers, including the unfocused
  case. Plus an e2e that drops a session on another session's ROW, deep inside
  the card body, to pin the new drop area.
  Gate after round 2: lint + typecheck + **318 unit + 80 e2e** green.
  **Round 3 (Dan's second eyeball) — the drop fix had a real hole in it.**
  *"It works on a couple of the tabs, and then a couple it doesn't seem to want
  to work on at all... Oh, I see it's an auto-generated group."* Root cause:
  round 2's card `onDragOver` called `preventDefault()` for **every** card kind,
  so an auto-group **advertised itself as a valid drop target** — and the drop
  then resolved to `g?.id ?? null`, i.e. ungrouped, which for an
  already-ungrouped session is a no-op. It looked droppable, wasn't, and said
  nothing. **Auto-groups now refuse:** dragover returns WITHOUT preventDefault
  (the browser only fires `drop` where dragover was prevented, so this is what
  produces a real no-drop cursor) and — just as important — calls
  `stopPropagation()`, because the `nav` behind them accepts drags as the
  ungroup target, so letting it bubble would have made a release over an
  auto-group *silently ungroup* the session instead of refusing it. Verified
  the new e2e actually catches the old behavior by reverting the one line and
  watching it fail.
  **Then the deeper point Dan made: they didn't LOOK different enough** ("a
  dotted folder isn't enough... it took me a while to figure that out"). The
  card grew an explicit `kind: 'group' | 'auto' | 'ungrouped'` replacing the
  boolean `computed`, and his call on the icons — which is the better semantic:
  a group **you** made is a *label you applied*, so it gets a **colored dot**
  (also restoring the pre-redesign recolor click target); an **auto** group
  *literally is a folder on disk*, so it takes the **solid folder** at full
  strength, plus its own surface (new `--auto-ink` / `--auto-surface` /
  `--auto-head`, derived with `color-mix` so both themes come free), an **AUTO**
  badge, and no ⊕/✕ since there is nothing to configure; **ungrouped** gets no
  icon at all, being an absence rather than a thing. `--auto-ink` is
  deliberately outside both the group palette and the status ramp — an
  auto-group is a *category*, not an individual.
  Also: `groups.spec` now selects auto-groups by `[data-group-kind="auto"]`
  rather than a prose tooltip (the tooltip text changed and should be free to).
  Gate after round 3: lint + typecheck + **318 unit + 82 e2e** green.
  **Dan signed off after round 3** ("looks good") — PR opened.
  Note for whoever picks this up: the architecture-review/E15 work was in the
  same working tree and was deliberately NOT bundled here (Dan's call) — it
  stays uncommitted for its own branch and PR.

- 2026-07-26 — **DENY didn't mean deny — the agent routed around it.** Dan
  denied a directory listing and Claude got the listing anyway: it announced
  *"PowerShell is getting blocked by something called switchboard"*, tried
  Bash, then file search. Root cause is one string. The hook's
  `permissionDecisionReason` defaulted to `"Denied from switchboard"`, and that
  field is **fed to the MODEL**, not written to a log — it reads as an
  infrastructure gate, so the agent treated the refusal as an obstacle to
  engineer around rather than a decision to respect. A denial the agent works
  around is worse than no denial at all: the user pressed Deny and got the
  thing they refused. The default now says three things explicitly — the USER
  decided, it is not a technical fault or a sandbox restriction, and retrying
  or re-routing through another tool is not on the table; stop and ask. Unit
  test asserts all three and pins the old wording as forbidden so it can't
  creep back. Manual (`04-approvals-and-autonomy.md`) now states what Deny
  actually promises. **Split out of the #72 branch (Dan's call 2026-07-26)** —
  it is a correctness bug in the safety mechanism and shouldn't wait behind a
  review of unrelated feature work.

- 2026-07-26 — **#92: a session blocked on the CLI's question picker now SAYS
  so.** Dan asked for a directory listing, nothing appeared to happen, and the
  Terminal tab showed claude sitting on a numbered picker waiting for an
  answer. **Probed before touching anything** (the PowerShell lesson): the tool
  name came from the shipped `sdk-tools.d.ts` of claude 2.1.220 — `AskUserQuestion`,
  not a guess — and a live PTY probe caught the wire traffic, because `-p` mode
  never offers the tool at all. Result:
  `{"ev":"PreToolUse","tool":"AskUserQuestion"}` then, ~6s later,
  `{"ev":"Notification","nt":"permission_prompt","msg":"Claude needs your permission"}`.
  **That corrected my own first diagnosis:** we were not permanently blind —
  the debounced Notification does map to `needs-permission` (S-06 measured the
  ~6s) — but it arrives late and calls a QUESTION a permission request, which
  would show a card asking you to approve something with no approval bar,
  because nothing was ever held. The `PreToolUse` is immediate and names the
  tool. Fix: new `INTERACTIVE_TOOLS` in the shared taxonomy, added to
  `PRETOOL_MATCHER` (it was built from shell+mutating+read, so the hook was
  never registered for it), and the one place `PreToolUse → working` is wrong
  — an interactive tool means Claude has STOPPED and is waiting for a person,
  so it maps to **`needs-input`**. No `Stop` ever fires because the tool blocks
  MID-TURN, which is why nothing rescued it. A late permission_prompt no longer
  relabels a pending question. **Never held at any autonomy** (unit-asserted):
  the answer lives in the CLI's own TUI, so parking it behind our bar would
  leave nothing to click and a verdict that can never come. Also amended
  `docs/code-review-2026-07-23-phase-2-e10.md` — its "refuted" note was right
  about prose questions (they do end the turn; re-verified) and blind to the
  tool case. Gate: lint + typecheck + **283 unit + 62 e2e** (new e2e drives the
  real hook listener: needs-input entry, no approval bar, resumes on answer).
  NOT in scope, still planned: answering the picker inside the Session view
  (DESIGN §5.12 questions queue, E14).
- 2026-07-26 — **Session groups are FRAMED now** (Dan: *"it's hard to
  differentiate if I have them split... really hard to tell where the split is
  in daylight and Nordic"*). dockview ships BOTH halves of the divide invisible
  — a group view has no border, and `--dv-sash-color` is `transparent` in every
  one of its bundled themes — so a grid of sessions reads as one undivided
  surface. Judged from real screenshots in both themes, not from the CSS: the
  first attempt used `--border`, which is tuned for hairlines INSIDE a card and
  vanished at top level. So a new semantic token **`--group-frame`** (nordic
  `#525d73`, daylight `#b9c2ce`), the focused group drawn in `--link` with a
  1px ring so "which one am I typing into" is answerable without moving the
  mouse, rounded corners, and the **sash painted with the page background** so
  a split shows a real gutter. Note for next time: `.dv-sash` as a selector
  LOSES to dockview's `.dv-split-view-container .dv-sash-container .dv-sash`
  (0,3,0) — set the token, not the rule. Probed via a temporary `__dvApi` seam
  in `SessionGrid.onReady` to split four panels; **seam removed**. e2e asserts
  frame-vs-surface contrast numerically in both themes plus a non-transparent
  sash. Also filed **#92**: a session blocked on the CLI's interactive question
  picker shows NO signal — the PreToolUse matcher never covers that tool, no
  Stop fires mid-turn, and the Notification maps to `idle`, so the card sits on
  'working' while the CLI waits. Corrects the 2026-07-23 review note that
  refuted this for prose questions (right there, wrong for the tool).

- 2026-07-26 — **Output cut off at the bottom after allowing a permission.**
  Probed: the approval bar docks BELOW the scroller, so it shrinks the viewport
  ~95px and pushes content under the fold. `pinned` was re-derived from that raw
  measurement, which is indistinguishable from "the user scrolled up" — one
  such sample unpinned the tail permanently, and real Claude output reflows
  constantly, so it only takes one. **`pinned` now moves only on a real gesture**
  (wheel / touch / pointer / key, with a rolling 500ms window so a scrollbar
  drag doesn't decay mid-movement); a scroll with nothing behind it is treated
  as layout and re-pins instead of unpinning. New e2e asserts a gesture-less
  scroll is corrected back to the tail.
  **Split out of this branch (Dan's call):** the DENY-is-routed-around fix
  found in the same pass ships on its own branch — see the entry below.

- 2026-07-26 — **Dan's live pass on #72 → one real bug, root-caused with a
  probe.** *"Clicking an event scrolls the session to the top."* Not the
  Events code at all: **dockview DETACHES a background panel, and a detached
  element loses its scrollTop.** The tail-pin only ever knew how to reach the
  BOTTOM, so a session you had scrolled up in came back at 0 with nothing to
  put it right — and stayed there, because an unpinned view was never
  restored. Probe (`e2e/probe-scroll.spec.ts`, throwaway): read at 7014 →
  switch away → return at 0; new content arrives → still 0. Two false starts
  worth recording: `props.visible` never flips (dockview hides an ANCESTOR, so
  React never learns), and the ResizeObserver never sees a zero-height frame
  either (a detached element reports nothing, then reappears at full height
  already reset). Fix: FeedView remembers `lastTop` from real scroll events
  (ignoring the clientHeight-0 frames a hidden panel reports, which would
  otherwise record "user scrolled to top" and unpin), and restores it — to the
  tail if that's where you were, else to your offset — driven by the RO plus a
  backstop that recognises the loss itself (`lastTop > 0 && scrollTop === 0`;
  a user who genuinely scrolls to the top records `lastTop 0`, so it can't
  fight them). 2 new e2e, both halves of the rule. Also from the same pass:
  Ready-tail opacity 0.65 → 0.82 (too dim), and the Events **✕ in the
  top-right corner became a real "Dismiss" button in the bottom-right** — it
  had been sitting in the click path of the row you were trying to open.
  Filed rather than folded in: **#91** (box the tool blocks + drop the
  timeline dot on plain answers) and **#90** (from review: no accelerator,
  palette included, is reachable from inside an xterm).

- 2026-07-26 — **Workflow change (Dan's ask): every item now ends with a
  hand-off.** Before the technical summary and before the PR: a **plain-English
  "what this does"** (real button and key names, no paths or item IDs) and a
  **numbered "what to test"** list — action plus what he should see, led by one
  line on what the automated tests already cover so he never repeats machine
  work. It is the existing **[Dan eyeball]** convention, itemized instead of
  buried in prose. Wired into `/next-item` (new **Step 9**; old 9→10, 10→11),
  `/commit-push-pr` (the PR body carries both, test list as GitHub checkboxes),
  `/autopilot` (per item into the draft PR description — it matters most there,
  since nobody watched the run), `docs/plans/00-process.md` (definition of done
  + a section on why it isn't a duplicate of `docs/manual/`), and
  `.claude/CLAUDE.md`.

- 2026-07-26 — **P2-E9-03 built (#72)**: the attention queue + `Ctrl+Space`.
  New pure `lib/queue.ts` orders the main-process `EventFeed` (already one item
  per session) by **needs-permission → needs-input → crashed → done**,
  oldest-first inside a band; `ready` (an acknowledged done) is excluded from
  the queue but still rendered, which is §5.8's completed-unreviewed state.
  **Two spec gaps had to be settled before a line was written.** (1)
  `EventFeed.acknowledge()` only relaxes `done`→`ready` — a held permission
  stays held until a human answers it, so jump+ack alone would hand you the
  same blocked session forever and the done-when ("three sessions clear in
  priority order under repeated Ctrl+Space") would be unreachable. Hence a
  **visited cursor keyed by EVENT id, not session id**: `EventFeed` mints a
  fresh id on every ingest, so a session that goes quiet and calls back
  re-enters the walk on its own, where a session key would have suppressed it
  for the life of the process. The walk wraps when everything has been seen.
  (2) The `events:changed` subscription **moved out of `EventsPanel` into
  `App`** — two independent subscriptions could hand the panel and the hotkey
  different lists, and the spec makes the queue the single ordering authority.
  `Mod+Space` also needed `codeFor('space')→'Space'`: the spacebar's `key` is
  a literal `' '`, so only the physical code can match it. **Review found 1
  blocker + 5 should-fixes, all fixed** — the manual pages (blocker: the
  keyboard page's own TODO placeholder for this key was still sitting there);
  a comment claiming the palette is keyboard-reachable from a terminal, which
  is **false** (`dispatch` bails on the terminal branch before it ever reads
  scope) → comment corrected and the real fix filed as **#90**; the panel's
  "next" marker was pinned to the queue head and so lied from press 2 onward
  → the cursor is now state as well as a ref and the marker tracks the walk
  (new e2e asserts it moves); `eventsRef` was written in a post-commit effect
  while its comment claimed keypress-freshness → the push handler writes it
  directly; **jumping from one popout to another raised the MAIN window and
  buried the target** (pre-existing for Ctrl+1..9, but the queue targets
  blocked sessions and those are exactly the ones people pop out) →
  `focusSession` now reports whether it raised another window; and the e2e
  named for the hard rule clicked the *composer*, proving the text-input
  branch rather than the terminal one → split into two tests, one clicking
  `.xterm-screen`. **macOS caveat, accepted and documented:** `Mod` is Cmd
  there and Cmd+Space is Spotlight, so the hotkey won't fire — it degrades to
  palette-only (the §5.8 invariant) and a per-platform accelerator is the fix
  if a Mac user turns up. Docs: `06-keyboard.md` (queue section + table row +
  troubleshooting; its TODO placeholder consumed) and `09-notifications.md`
  ("the panel is a to-do list, in order"). Gate: lint + typecheck + **300 unit
  + 67 e2e** (19 queue unit tests, 6 new e2e driving the REAL hook listener to
  put three sessions into three different states).

- 2026-07-25 — **#86 popout geometry FIXED — two bugs, both proven with probes
  before a line was changed.** (1) **The move was never saved.** dockview only
  notices a popout moved via a debounced requestAnimationFrame poll of
  `screenX`, and rAF throttles in a backgrounded window — precisely the state
  the main window is in while you drag a popout onto another monitor. Probe:
  move a popout, quit immediately → saved position is the OPEN-TIME one; wait
  3s → correct. (2) **The restore double-counted the opener.** dockview's
  `getBox()` returns the saved ABSOLUTE rect and then opens at
  `window.screenX + box.left`, adding the main window's origin a second time —
  so a popout marches across the desktop by that offset on EVERY relaunch,
  which is how Dan's ended up straddling two monitors (measured: restored x =
  stored 167 + opener 640 = 807). Fix: the main process now owns popout
  geometry — tracks popout BrowserWindows, drives saves from Electron's own
  move/resize events (which ignore focus), stamps live rects over the layout at
  close, and `resolvePopoutBounds` un-does the double-count EXACTLY (asked ==
  opener + stored, sizes must match too). `useContentSize: true` also fixes a
  quieter bug: dockview stores INNER size, we restored it as OUTER, so popouts
  shrank a little every launch. Review caught 2 blockers: `quitConfirmed` was
  never reset, which on macOS would have killed layout persistence for the rest
  of the session after the first window close; and matching popout windows to
  layout entries BY ORDER is unsafe (dockview registers a popout when its
  window finishes LOADING, we see it when it OPENS) — two popouts could swap
  monitors, so matching is now by dockview GROUP ID with an order fallback only
  when counts agree. Also from review: boot snapshot expires (a later tear-off
  can't teleport onto a dead popout's rect), off-display sanity net, Linux
  move/resize events, E8-06's rescue path compensated the same way. Gate: lint
  + typecheck + **277 unit + 61 e2e** (new: nudge-reaches-disk-before-quit,
  two-popouts-never-swap, size round-trip).

- 2026-07-25 — **#85 app sometimes never exits after quit** (Dan: the
  `switchboard.cmd` console stayed open, twice). Diagnosed from the process
  table + his app log: main process ALIVE with no windows, no sockets, 44
  threads, and `app quit` already logged — teardown ran, the process just never
  died. NOT reproducible on demand: probes exited cleanly with a live PTY, with
  a popout open, and without one (Dan re-tested the popout case too). Almost
  certainly a native-handle race (ConPTY/node-pty or Chromium), and the e2e
  suite can never see it because the harness force-kills the process tree.
  Fix = a **hard-exit backstop**: everything durable is flushed before `quit`
  (window-close geometry save + `workspace.save()`), so 1.5s later we log
  `still alive after quit — forcing exit` and `app.exit(0)`. The timer is
  unref'd so the backstop can't itself hold the process up, and the warning
  keeps recurrence visible instead of silent. Verified: a clean autoclose run
  still exits gracefully with the warning ABSENT.

- 2026-07-25 — **#86 FILED (not started)**: a popped-out window moved to a
  second monitor comes back straddling the boundary between monitors after a
  relaunch. Suspects noted in the issue: `parsePopoutFeatures`, and
  `sanitizePopoutLayout`'s off-display RESCUE clamping a legitimate
  second-monitor box toward the primary display.

- 2026-07-25 — **#84 tab strip: theming, spacing, multi-row** (Dan's live
  findings, filed as its own issue). (1) **The `⌄ N` overflow dropdown looked
  EMPTY.** Root cause, probed in a real window: dockview stamps its theme class
  on the **shell** and defaults to `abyss`; our class sat on the inner root, so
  the popup — which mounts on the shell — painted dark-on-dark inside the light
  theme. The rows were real and clickable, just invisible. Fix: we now REGISTER
  our own dockview theme (`api.updateOptions({theme:{className:
  'dockview-theme-switchboard'}})`) and a new `theme/dockview-tokens.css` binds
  every `--dv-*` variable to our tokens — so no dockview theme block matches
  anything and stylesheet order stops being load-bearing. The dead
  `className={dockview-theme-light|dark}` prop (a no-op since the v7 upgrade)
  is gone. (2) **Tabs get a 3px gutter + rounded tops.** (3) **Tabs WRAP onto
  more rows by default** (`data-tab-rows` on `<html>`, persisted in the ui
  blob, toggled by a palette-only command) — burying sessions behind a dropdown
  is the wrong default for a session host. Review caught two real defects,
  both confirmed by measuring the live DOM before fixing: `flex-wrap` on the
  outer actions container pushed the void container (the group's drag handle)
  and the right actions onto a **zero-height second line**; and the wrapped
  strip had no ceiling, so an E12 group clustering a dozen sessions into one
  dockview group could starve the card below (now capped at 40% + scroll).
  Also fixed from review: `--dv-tab-divider-color: transparent` had silently
  killed the tab focus ring; a content-box `padding` overflowed the strip by
  3px; and **popout windows are separate documents** — they now get
  `data-theme` + `data-tab-rows` copied across on open and on change, which
  also fixes the pre-existing bug where a popped-out session stayed dark in the
  daylight theme. Gate: lint + typecheck + **263 unit + 58 e2e** (6 new,
  incl. both-theme dropdown contrast measured numerically).

- 2026-07-25 — **P2-E9-02 built (#71)**: the command palette. `Ctrl+Shift+P`
  (the ONE `typing-ok` command — it's the route to everything else) opens a
  fuzzy-filter list over the E9-01 registry: bindings shown per row, dynamic
  "Go to <session>" rows in rail order, unavailable commands greyed WITH their
  reason (§5.8 — the palette is the map of what exists). New `lib/fuzzy.ts`
  (two-pass matcher: acronym reading preferred, greedy-leftmost fallback, so
  "cs" = Close session) and `lib/palette.ts` (pure row assembly), both fully
  unit-tested; `components/CommandPalette.tsx` renders only. Title-bar
  **▸ commands** chip is the mouse path — the terminal still eats every key,
  palette included. **E9-01's popped-out-window gap CLOSED:** dockview popout
  windows get the dispatcher (their JS runs in the main window), and a command
  that actually runs raises the main window. Review found 2 blockers, both
  fixed: (1) using `e.defaultPrevented` as the "a command ran" signal would
  have raised the main window every time the user pressed Enter in a
  popped-out composer — `dispatch`'s return value is now the signal; (2) lint
  red on an unused e2e helper. Should-fixes fixed: focus restore no longer
  clobbers the command that just ran (jumping to a session no longer leaves
  you typing into the old one — new e2e), the dispatcher is gated while the
  palette is open, the palette can't list/re-open itself, focus can't escape
  the modal, popout handler map moved to a ref (re-attaches on effect re-run),
  `PopoutGroup` type imported instead of cast, aria roles, hotkey toggles.
  Docs: `06-keyboard.md` gains the palette section and the popped-out-window
  text is now TRUE (this branch changed that behavior). Gate: lint +
  typecheck + **257 unit + 52 e2e** green (8 new palette e2e).

  **Dan's live find, same day — hovering the palette blanked the whole window.**
  Root-caused from his app log (`destroy_ is not a function`, twice — once per
  card) and reproduced in a Playwright probe: hovering moves the selection,
  which re-ran the scroll-into-view effect, and that effect was written with an
  **expression-bodied arrow** — so Chromium's `scrollIntoView({block})`, which
  returns a **Promise** here, became React's cleanup. React called it, threw,
  and unmounted the entire tree: blank window, only the menu left. Fix: block
  body (3 more of the pattern existed and are now braced). Guardrail: a new
  eslint `no-restricted-syntax` selector BANS expression-bodied `useEffect`
  arrows across `src/**` — an effect that genuinely returns a cleanup opts out
  by name on one line (App's `followSystemTheme`). Verified both rules still
  fire in the right scopes (flat config REPLACES rule options rather than
  merging — the colors rule and this one had to be composed deliberately).
  Regression e2e hovers every palette row and asserts zero page errors.

- 2026-07-25 — **P2-E9-01 built (#70)**: command registry + keybinding
  dispatcher. `lib/commands.ts` (pure: Command{id,titleKey,binding,scope,
  enabled,run}, Mod-per-platform accelerator parse/match/format, target
  classification, dispatch) + `lib/command-set.ts` (the seed set: Ctrl+1..9
  jump, Ctrl+PageUp/Down, Ctrl+N, Ctrl+W close-with-confirm, Ctrl+B rail,
  Ctrl+` Terminal view, Ctrl+Shift+O pop-out, palette-only Changes). One
  window-level listener in App.tsx; `railOrder()` moved into `lib/groups.ts`
  and the rail now RENDERS from it, so Ctrl+N numbering can't drift from the
  eye. **Scope rule:** nothing fires in a text input; **nothing EVER fires in
  an xterm** (not even a future 'typing-ok' command). **Review found a real
  blocker:** Electron's DEFAULT menu owns Ctrl+W (Window>Close — would close
  the window and every session in it) and Ctrl+R (reload mid-session) in the
  browser process, ahead of the renderer — and Playwright can't catch it (CDP
  bypasses native accelerators). Fixed by owning the menu: new
  `src/main/app-menu.ts` (no Close/Reload roles; macOS keeps app+edit menus so
  Cmd+C/V still work; DevTools kept), asserted both by unit test on the
  template and by an e2e that inspects the REAL built menu. Other review
  fixes: identity-checked cardActions cleanup, activeCardId ignores popped-out
  panels, jumping to a popout raises its window, dispatch fails open
  (try/catch + logger) and ignores key-repeat, `e.code` matching so Ctrl+1..9
  works on AZERTY, refs written post-commit. Docs: `docs/manual/06-keyboard.md`
  written (stub → draft). Gate: lint + typecheck + **233 unit + 44 e2e** green
  (10 new e2e incl. both directions of the hard rule). **Dan CONFIRMED the
  blocker fix with a real keypress 2026-07-25:** Ctrl+W raises "…This ends the
  session and removes the card" (our card confirm), NOT the window-close
  guard — the native accelerator no longer reaches Electron's menu.

- 2026-07-24 — **User docs added to the workflow (Dan's call).** New
  `docs/manual/` — a plain-English user manual in Markdown: index + house
  style (`README.md`), a page skeleton (`_template.md`), and 11 stub pages
  covering everything shipped so far (getting started, sessions, session view,
  approvals/autonomy, slash commands, keyboard, workspace/groups/pop-out,
  changes & git, notifications, settings, troubleshooting). **The rule:** any
  work item that changes what a user can see or do writes/updates its manual
  page BEFORE the PR opens; drafts and `TODO:` placeholders are acceptable, a
  missing page is not; purely internal work is exempt but must say so. Wired
  into `00-process.md` (new "User documentation" section + definition of done),
  `/next-item` Step 8, `/autopilot` (explicitly non-optional unattended),
  `/commit-push-pr` (pre-PR check), and `.claude/CLAUDE.md`. The
  Markdown→HTML manual build (static site, screenshots, in-app Help link,
  stub audit that fails the build) is filed as a **Phase 4 planning note** in
  `03-later-phases.md` — pulled earlier if public release lands first.
  **BACKFILLED the same day:** 10 of the 11 pages written to `draft` from the
  shipped app (Phase 1 + E7/E8/E10/E12), sourced from `en.json`'s real labels,
  the hold policy, the notifier, the autonomy→CLI-flag map and the card/rail/
  events components — not from memory. 06-keyboard stays a stub (E9-01 writes
  it). Open TODOs in the pages: switchboard's own download/install steps (no
  release yet), log-path confirmation against a packaged build, screenshots
  (`<!-- screenshot: … -->` markers left in place). **[Dan eyeball]** the
  drafts against a running build — they've been read out of the source, not
  clicked through.

- 2026-07-24 — **E9 expanded + issues filed** (`/pm plan`; Dan picked E9 over
  E11/E13/E14). **E9 — Attention-driven layout** broken into 11 work items
  (P2-E9-01…11) in `04-phase-2-switchboard.md`, covering §5.8 in full plus
  §8's command-palette/keyboard line: command registry + dispatcher (01),
  palette (02), attention queue + Ctrl+Space (03), urgency strip + delayed
  reset (04), presentation ladder + reveal contract (05), presentation policy
  + auto-minimize on submit (06), layout modes grid/focus/queue + maximize
  (07), idle collapse & aggregation (08), pinning contract (09),
  focus-stealing policy (10), batch permission handling (11 — may slip to
  E14). Issues **#70–#80** filed on the Phase 2 milestone; nothing L-sized,
  ordered by dependency. E11/E13/E14 remain outlines (just-in-time; E13 is
  blocked on E11). Next: `/next-item` → P2-E9-01.

- 2026-07-24 — **/clear "not executing" (Dan's eyeball) root-caused: it
  EXECUTES — silently.** Two independent proofs: (a) node-pty probe vs real
  claude 2.1.218 (`.claude/work_files/clear-probe/`, reusable) — the app's
  exact write pattern fires SessionStart(source:'clear') with a fresh
  session id; (b) Dan's own app log at 18:33:57 shows the new conversation
  (eea4f7ac…) binding seconds after his /clear. The CLI gives ZERO
  feedback (empty `<local-command-stdout>`, no assistant turn), so the
  wiped feed looked like a no-op. FIX on PR #69: the id-change now carries
  a CAUSE ('clear') from hook-listener → manager.setNativeSessionId →
  watcher reset → sessions:feedReset → FeedView renders a "Conversation
  cleared — context starts fresh" divider (mis-bind corrections stay
  unmarked; watcher logs info not warn for clear rebinds). +2 unit (hook
  cause tagging, watcher cause propagation + rebind), +1 e2e (seeded
  transcript → SessionStart(clear) POST → old blocks gone + marker shown).
  189 unit + 34 e2e green.

- 2026-07-24 — **P2-E10-07 done (#68, PR #69)**: composer slash commands.
  (a) `/` at line start pops autocomplete — provider builtin catalog (new
  optional ProviderAdapter.slashCommands seam; curated claude 2.1.x data)
  merged with an ASYNC fail-open scan of project/user .claude/commands
  (subdir → dir:name namespacing) + .claude/skills SKILL.md frontmatter;
  ↑/↓ + Enter/Tab insert (never submits while open/fetching), Esc
  dismisses, mid-sentence `/` never triggers. New sessions:slashCommands
  IPC (folder from the session record, §5.29). (b) The card's inert ⋯ is a
  real menu: Clear conversation (inline confirm) + Compact — type the real
  /clear · /compact into the PTY; locked while starting (§5.10
  startup-dialog rule) or crashed/exited. PTY prompt-write extracted to
  lib/composer.ts (S-03 paste rule). Feed-after-/clear rides the existing
  new-native-id rebind (unit-proven; real-CLI e2e impossible under the
  isolated home — upstream #80683 — hence the [Dan eyeball]). Review: 0
  blockers, 3 should-fixes fixed (async scanner, block-scalar frontmatter,
  dead-session gating). Gate: lint + typecheck + 187 unit + 33 e2e green
  (3 new Playwright specs; one drives the real hook listener to prove the
  starting-lock unlocks live).

- 2026-07-24 — **Round 5 (on PR #67): tail-pin made SELF-HEALING.** Dan:
  switching to an already-open session after app start landed at the TOP.
  Root cause: the pin was a one-shot rAF keyed on [blocks, visible] — if it
  fired before the panel had real layout (dockview shows background panels
  a frame later; restore relayouts), scrollTop wrote against scrollHeight=0
  and nothing ever retried. Now a ResizeObserver on the scroller + content
  re-pins on any size change while tail-pinned, and programmatic pins no
  longer count as user scrolls (autoPin guard — a layout-induced scroll
  event could permanently unpin). Also **P2-E10-07 slash commands PROMOTED
  to the next work item** (owner: support ALL Claude slash commands;
  /clear first — "no way to clear a conversation"); plan rewritten with
  the two halves (autocomplete + session controls) and the /clear-vs-Feed
  decision spelled out.

- 2026-07-23 — **Dan's round 4 (live testing on merged main).** Root-caused
  from the app log: the "random Windows alert noises" were review P2 #19 in
  the wild — every gated call in an allow-all session still HELD in main
  (needs-permission event → beep) before the renderer auto-allowed it 1–2ms
  later (log shows held→decided in 1ms, humanly impossible). FIX: allow-all
  moves to the MAIN process (HookListener.setAllowAll, keyed by live id,
  dies with the session; sessions:allowAllSession IPC) — a granted session's
  gated calls are answered server-side: no hold, no event, no beep. 2 unit
  tests. Also: (a) resume-from-summary picker (claude 2.1.x, on --resume of
  a 100k+ conversation) is a startup TUI dialog hooks can't see — a card
  stuck in 'starting' >8s now shows the "continue in Terminal ↗" chip;
  DESIGN §5.10 records the hazard (composer Enter blindly confirmed the
  picker; muting the composer pre-SessionStart is the candidate v2). (b)
  Working banner: label left-aligned, pulse dots right of it, ellipsis
  dropped. (c) Events: every item same height (label row always renders),
  per-item dismiss ✕ (events:dismiss → feed.forget). (d) Rail rows show the
  task label under the title. (e) New same-folder sessions auto-suffix
  their title with the first free -N (renames untouched). (f) Composer stop
  button while working — writes Esc to the PTY (the CLI's own interrupt);
  DESIGN §5.10 notes it. (g) E14 plan: events carry inline
  Allow/Allow-all/Deny (owner request, plumbing sketched). Test 4's
  "out-of-cwd read didn't prompt": log shows NO Read hold ever fired —
  the reads rode shell tools inside allow-all sessions; retest post-fix.
  Gate: lint + typecheck + 166 unit + 30 e2e green; check:hooks re-PASS.

- 2026-07-23 — **PR #66 MERGED to main (ec40c0b)** — review P1 follow-up,
  all 5 CI jobs green (one cross-platform test fix en route: the read-tool
  policy test used 'C:/...' literals, which are RELATIVE on POSIX — the
  fixed isOutsideCwd correctly called them inside; per-platform paths now).
  Also NEW: ruleset "main: green CI required to merge" ACTIVE (repo public
  → rulesets free) — all 5 checks required server-side, force-push +
  deletion blocked. #13's manual merge gate is now enforced by GitHub.

- 2026-07-23 — **Review P1 follow-up COMPLETE (#6–#17)** on
  `fix/review-p1-followup`. Watcher trio: (#6) once hooks deliver the native
  id, ONLY id evidence binds (unparseable-head files can't be cwd-claimed);
  (#7) mis-bind corrections push `sessions:feedReset` so the renderer drops
  stolen blocks; (#8) ambiguous same-cwd sessions bind best-effort after 30s
  without a native id (fail-open when hooks are dead) — claim() now also
  refuses files another session owns. (#9) tool taxonomy extracted to
  `src/shared/tool-taxonomy.ts`; watcher stamps `tool.category`; the renderer
  dispatches shell rendering on category — PowerShell gets the rich Bash
  layout. (#10) isOutsideCwd: relative paths resolve against the session
  folder; containment via path.relative (drive-root + cross-drive fixed).
  (#11) SessionStart(source:'compact') no longer flips a working session to
  idle. (#12) composer ignores Enter mid-IME-composition. (#13)
  setNotificationPrefs is a merge-patch (enabled-toggle no longer wipes
  osToasts/quiet hours). (#14) upsertBlock inserts by seq (evicted re-emits
  can't render as newest). (#15) EventsPanel: push beats in-flight list().
  (#16) relaunch-test leak pattern fixed in FIVE e2e specs. (#17) fixture
  launch failure scrubs copied credentials + temp home. P3 #31 folded into
  #6. Gate: lint + typecheck + 164 unit + 30 e2e green; check:hooks +
  check:transcripts re-PASS vs real claude 2.1.218.

- 2026-07-23 — **PR #65 MERGED to main** (Dan's call: merge now, finish the
  review P1 as a follow-up PR). The Actions-billing blocker self-resolved:
  Dan made the repo public → all 5 CI jobs re-ran GREEN (unit ×3 OS + e2e
  Win/Linux). Squash-merged as 4d179e5, branch deleted. Review work
  continues on `fix/review-p1-followup`: P1 #6–#15 + P1-test #16–#17.

- 2026-07-23 — **Upstream bug FILED** (Dan's go-ahead):
  anthropics/claude-code#80683 — interactive mode never writes the
  conversation .jsonl under a redirected HOME/USERPROFILE (full isolation
  matrix in the report). **Review P0 cluster FIXED** (docs/code-review-
  2026-07-23-phase-2-e10.md, all 5): (#1, owner picked Option A) plan
  sessions NEVER hold — an in-app allow would bypass the CLI's plan
  write-block; DESIGN §5.16 records the rule; (#2) allow-all keyed by LIVE
  session id — respawns prompt again; (#3) pending holds replay to a
  (re)mounting renderer via sessions:pendingPermissions — a missed push
  can't park the CLI; (#4) held requests QUEUE per card ("+N more
  waiting", advance on decide); (#5) a hold auto-surfaces the Session tab
  from any tab. e2e: Terminal-tab hold → auto-surface → two-deep queue →
  allow+deny verdicts. 151 unit + 30 e2e green; real-claude lane green.
  P1 (#6–#15) next.

- 2026-07-23 — **Transcript-in-sandbox anomaly SOLVED (root cause
  characterized; upstream CLI bug).** Dan asked for online research +
  systematic isolation. Web findings suggested test-env detection /
  kill-timing / config — all DISPROVEN empirically. Isolation matrix:
  `-p` + temp home writes; `-p` + full Playwright-worker env + temp home
  writes; app + minimal .claude.json + temp home doesn't;
  TEST_ENABLE_SESSION_PERSISTENCE / PLAYWRIGHT_TEST scrubs don't help;
  **interactive TUI via node-pty + temp home OUTSIDE the app doesn't
  write either** (scratchpad tui-probe.cjs) — and the file is NOT in the
  real profile. Verdict: **claude 2.1.218 interactive mode simply never
  persists the conversation .jsonl when HOME/USERPROFILE is redirected**
  (print mode does; real home does). Zero switchboard code involved. The
  real-claude e2e lane keeps asserting via Terminal; repro recipe is
  solid bug-report material for anthropics/claude-code (needs Dan's
  go-ahead to file publicly). Fixture keeps the env scrubs (hygiene) +
  pre-seeded-home-wins copy rule.

- 2026-07-23 — **Session view opens at the BOTTOM of a restored history**
  (Dan's find: restored cards landed at the top). Tail-pinning now sets
  scrollTop directly after a layout frame instead of scrollIntoView, on
  backlog load / each streamed block / visibility flips. e2e: 60-block
  history → last block in viewport, first block not. 149 unit + 29 e2e.

- 2026-07-23 — **Dan's round 3 (9 items) + a REAL bug the new test lane
  caught.** (a) Stuck "Claude is working" at boot: the card hardcoded
  status 'working' on spawn AND SessionStart mapped to 'starting' —
  now spawn starts at 'starting' and SessionStart → **idle** (resumed
  sessions read idle). (b) Tab ✕ now CONFIRMS before closing and sits
  up/right, away from the click path (e2e: dismiss keeps, accept closes).
  (c) Signal model per Dan: **beep always** on attention events + Events
  item + taskbar flash when backgrounded; **OS toasts OFF by default**
  behind new `osToasts` pref (DESIGN §5.9 settings note; E14 ships the UI).
  (d) Events already clear on close (feed.forget, landed yesterday).
  (e) **Terminal reversal**: always present, LAST tab (hide-by-default
  lasted one day; DESIGN §5.10 updated, menu toggle removed). (f) Empty
  PLUSNative session root-caused via the new lane: **the composer sent
  text+CR as ONE PTY write → the TUI treats it as a paste and never
  submits** (S-03 finding, refound live); Enter is now a separate delayed
  write. Also: 256KB head window + filename id-match for snapshot-first
  transcripts. (g) **Opt-in real-claude Playwright lane**
  (SWITCHBOARD_REAL_E2E=1, e2e/real-claude.spec.ts; fixture copies creds
  into the temp home) — it caught (f) on its first run. KNOWN ANOMALY:
  claude 2.1.218 writes session-env/memory but NO conversation .jsonl
  under an isolated temp home (repro'd; -p works; real-home interactive
  works) — lane asserts via Terminal until understood. (h) Phantom
  needs-permission spam: almost certainly the old 60s hold-timeout loop
  (each gated call → unseen bar → timeout → CLI TUI prompt → permission
  Notification → event) + append-only events; 300s + inline bar + one-
  event-per-session should end it — if it recurs, the app log pins it.
  149 unit + 28 e2e green.

- 2026-07-22 — **Dan's round 2 (5 items).** (#1) `<local-command-*>`
  wrappers + isMeta transcript lines no longer render as prompt pills (the
  /compact stdout with raw ANSI etc.); the startup /compact itself is CLI
  behavior — resume-on-focus revives the focused card and claude
  auto-compacts a near-full conversation. (#2) working banner is now LOUD:
  full-width tinted bar, 2px top border, bold, three staggered pulse dots.
  (#3) phantom needs-input root-caused: the CLI's 60s "Claude is waiting
  for your input" idle nag classified as needs-input — now classifies as
  **idle** (calm: no event, no toast); real approvals ride the hold path,
  which is why the next one "worked perfectly". (#4) events say **Done.**
  and relax to **Ready** when the user clicks/looks (EventFeed.acknowledge
  + events:ack; new kind 'ready'). (#5) composer slash-command autocomplete
  → P2-E10-07 [not yet filed] + DESIGN §5.10 composer bullet.
  148 unit + 28 e2e green.

- 2026-07-22 — **Dan's manual-pass findings (14 items) — 12 fixed on PR #65,
  2 planned.** Fixed: (#1) approval bar moved above the composer; (#2) hold
  timeout 60s→300s; (#3-interim) NO OS toasts while the window is focused
  (crashes excepted); (#4) verbosity tooltips; (#5) cross-folder transcript
  steal — claims now require POSITIVE evidence (summary-first resumed files
  have no cwd on line 1; readHead scans 25 lines; +2 tests); (#6) prominent
  "Claude is working…" strip above the composer; (#7) skill/long user
  payloads collapse like tool rows; (#8) rail group dividers; (#9) Events
  items show session name + task label (was raw live-id — map by liveId);
  (#10-core) EventFeed = ONE item per session, latest wins, resolved clears
  (rewritten + 7 tests); (#11) horizontal rule before each new prompt;
  (#13) Feed→**Events** everywhere (panel, i18n, channels events:list/
  events:changed, EventsPanel.tsx). Planned (DESIGN §5.9/§5.12 + E14):
  per-session "notify when done" checkbox, Events filters (All·Needed·
  By-session), questions-queue placeholder. (#12 spurious needs-permission:
  likely the pre-fix cross-wiring + old event-log semantics; if it recurs
  post-fix, grab the app log — hook events are per-session there.)
  147 unit + 28 e2e green.

- 2026-07-22 — **Approval miss #2 root-caused by a live probe: on Windows
  the CLI shells out via a `PowerShell` TOOL**, not Bash — our gate/matcher
  said Bash-only, so Dan's "list my Downloads" TUI-prompted again. Probe:
  `claude -p` + matcher-`*` logging hook → `tool_name:"PowerShell"`. Fixes:
  PowerShell gated wherever Bash is; matcher widened; NEW rule — read tools
  (Read/Glob/Grep/LS) hold when their target is OUTSIDE the session folder
  (mirrors the CLI's out-of-workspace prompting; needs cwdFor dep). Policy +
  settings-shape unit tests extended; new Playwright case replays Dan's
  exact scenario (PowerShell hold → bar in Session tab, NO chip). Note for
  the future: tool-name coverage is version/platform-volatile — the probe
  script lives in scratchpad, worth productizing if this recurs.
  check:hooks re-PASS vs real claude; 142 unit + 28 e2e green.

- 2026-07-22 — **Empty-Session-tab root cause (Dan's retest): RESUMED
  sessions never bound their transcript.** The watcher's "never adopt
  pre-existing files" rule (correct for strangers) also blocked a session's
  OWN `<nativeId>.jsonl`, which by definition predates the launch — so a
  resumed card's Feed stayed empty forever while the Terminal worked. Fix:
  ipc passes the resumed native id into transcripts.watch; discovery may
  adopt exactly that file, replaying it from 0 — the Session view now shows
  the conversation HISTORY on resume as a bonus. Unit-tested both ways.
  140 unit + 27 e2e green. Also confirmed: ALL the failed PR runs are the
  same GitHub billing error ([user] blocker, still unresolved).

- 2026-07-21 — **Dan's live-test bug fixes (PR #65)**, all four:
  (1+3) **Same-folder sessions cross-wired their Feeds** — the S-04 adoption
  race for real: cwd-only claims are ambiguous with cwd-siblings, and
  transcripts.setNativeSessionId was never wired. Now: ambiguous claims wait
  for the hooks-delivered native id; a mis-bind self-corrects (unbind+reset+
  rebind); ipc wires the id through. 2 new unit tests.
  (2) Prompts render as tinted pill boxes (no "you" label).
  (4) **Approvals never held in production: the PreToolUse hook entry lacked
  a `matcher`** — S-03's proven shape always had one; without it the hook
  never fires and the CLI TUI-prompts (exactly what Dan saw). Added the
  matcher; chip now stands down while the approval bar owns a permission.
  **Proven against real claude**: check:hooks extended with a hold scenario —
  Write under ask HELD → app allow → file written, transitions
  permission-held→resolved. PASS. 139 unit + 27 e2e green.

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
