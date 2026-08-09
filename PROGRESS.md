# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Phase 2 - The Switchboard (E7+E8+E10+E12 complete & merged;
**E18-01…10 ALL DONE 2026-08-02**; E15 done except #111 [held — real tokens];
E9: #70–#77 done, **#78/#79 in Dan's queue** (PRs #287/#301), #80 held on a
scoping call; **E19 release/auto-update NEW 2026-08-05** — 01/02 merged, 03
in Dan's queue, 04 held on #276's merge; E11/E13/E14 still outlines)
**In progress:** **🎛 RUN 10 CLOSED 2026-08-08 + FULLY MERGED** — close-out
block below; all 3 PRs on main (#356 #357 #359). Run 8: Run 7
CLOSED 2026-08-06 + FULLY MERGED (train #321) + **v0.1.1 LIVE**. Before run 7: 🎉 **RELEASE v0.1.0 CUT
2026-08-06** — the run-6 merge train (13 PRs) is FULLY MERGED
(Dan-authorized, serial bump+re-green, 5 real conflict sets + 3
semantic integrations resolved), tag v0.1.0 pushed, the release
workflow's FIRST REAL RUN succeeded (release live with installer +
sha256 + changelog notes), and **switchboard 0.1.0 is INSTALLED
per-user on Dan's machine at the tagged tree** (stamp 7890d2b in
both bundles). Zero open PRs. 🎛 Run 6 CLOSED 2026-08-05 (block
below): 22 items — 9 internal merged in-run, 13 user-facing merged
by the train. Run 5 CLOSED 2026-08-05: 14 items — 8 internal merged
in-run, 6 user-facing merged same day by the Dan-authorized train.
Run 4 CLOSED
2026-08-04 and **FULLY MERGED same day** — 10 items: 7 internal +
3 user-facing (Dan authorized the merge train without hand-testing;
serial train #214 → #220 → #226, each bumped + re-greened; #226
needed one conflict resolution — workspace-readonly.spec.ts, #226's
structure adopting #228's temp-dir registry, verified by a local
3/3 spec run before push). **Main @ c701f37.** Unit 1294 / e2e
161+1 skip (from the merged branches' gate runs: 1227+46+5+16 /
156+4+0+1).

> # ▶▶ START HERE — 🎛 RUN 10 CLOSED 2026-08-08 (~4 h wall, two waves +
> branding, 6 items shipped)
>
> **Final state: 5 of 6 MERGED, 1 in Dan's queue.** Wave 1: #352 (PR
> #356 → f4bb8ce), #355 (PR #357 → 8f50a53), #354 (PR #359 → 6a3ab32).
> Branding: #361 (PR #362 → 7fe7689, Dan's WIP committed at his
> instruction). Wave 2: #360 (PR #363 → 785f455, internal — one
> update-branch bump + re-green, the run's only bump) and **#358 → PR
> #364, UF, CI 4/4 GREEN, IN DAN'S QUEUE** (Narrator-based hand-test
> list in the PR body / 358.md — the one judgement call to weigh: an
> already-suspended card stays QUIET at boot by design). **Main @
> 785f455, out/ REBUILT, stamp verified both bundles — `npm start` is
> current.** Issues #352 #354 #355 #360 #361 closed. **Filed this run:
> #358** (done same-run) **#360** (done same-run) **#365** (hex-lint
> false-positive on '#358'-style strings) **#366** (no e2e kills a LIVE
> session) **#367** (PreflightBanner's stale §5.26 citation + srOnly ×2)
> — #365/#366/#367 are the next run's queue (all unblocked, small).
> Worktrees: all three detached/clean. Skill updated twice from run
> lessons (subagents inherit safety clauses; poll-then-run split;
> tasklist grep -c gotcha). CHANGELOG: FOUR items now owed under a
> `0.1.3 — unreleased` section nobody may open but a release action —
> #353 is the ticket, Dan's. #346 (broker refusal contract) still
> Dan's decision. One incident (reviewer swept live %TEMP%, no loss) —
> block below, process gap closed.
>
> **Wave 2 (dispatched after Dan's "continue"):**
> - **#358** ✅ DONE (~56 min) → **PR #364 READY, IN DAN'S QUEUE** (UF —
>   assistive-tech behavior; CI pending at last check). One sr-only
>   `role="status" aria-live="polite"` region at the CARD ROOT (not the
>   overlay — a live region inserted already holding text announces
>   nothing; the repo has hit that trap twice, #222/#168). Pure
>   `overlaySaid()` mapper pinned (+7 unit incl. a precedence table);
>   +5 e2e assertions incl. the load-bearing `toBeEmpty()` on a healthy
>   card — mutation-proved (the "harmless tidy-up" revert goes red ONLY
>   on that assertion). Session name announced first (#196's reason).
>   Judgement call flagged for Dan: NO one-commit defer — a card that
>   mounts already-suspended stays QUIET at boot by design (changes
>   announce, restored state doesn't). Zero pixels/copy/i18n changed.
>   Gate: lint/typecheck clean · 2652 unit · 200+1 e2e (lock: waited 7
>   min behind #360, attempt 8, nothing stolen). Manual: 02-sessions +
>   06-keyboard pre-PR. Discoveries → **#365** (hex-color lint
>   false-positives on '#358'-style strings), **#366** (no e2e kills a
>   LIVE session — died flow only covered via never-started), **#367**
>   (PreflightBanner cites §5.26 wrongly + srOnly ×2) all filed;
>   CHANGELOG third strike (→ #353); Playwright gotcha recorded in the
>   handoff (`.filter({visible:true})` does NOT exclude sr-only
>   elements — 1×1 clipped counts as visible; testid is the fix).
>   Lock lesson → written into the /orchestrate skill (poll in one
>   Bash call, run in the next; the 10-min cap killed a combined call
>   mid-suite while HOLDING the lock). Handoff: 358.md.
> - **#360** ✅ DONE (~75 min) → **PR #363 (INTERNAL), CI 4/4 green but
>   BEHIND after branding/#364 moved main — bumped via update-branch,
>   orchestrator merges on re-green.** Not just hygiene: main leaked
>   **11 dirs per `npm test`** (scripts/release-notes + sha256-sidecar
>   tests had NO teardown — outside the issue's list, which only
>   enumerated src/; worker took them, measured 11→0 against isolated
>   TEMP). All 5 named files + 3 scripts tests onto tempDir()/
>   cleanupTempDirs(); two bespoke Windows-requeue copies deleted;
>   update tests' bare rmSync (the #167 phantom-failure shape) gone.
>   sweepBeforeTests moved INTO sweep-temp-orphans.js, both globalSetups
>   now 3-line adapters (budget/opt-out/fail-open can't drift); e2e
>   guards first then sweeps, proved both directions on fixture TEMPs.
>   Safety: fixtures-only clause carried verbatim into the reviewer's
>   prompt (it executed nothing); `withTempDirAt` now shared and THROWS
>   if the redirect didn't take — the run-10 incident cited in its
>   docstring. Gate: lint/typecheck clean · 2651 unit (+6, 0 sb-* left) ·
>   200+1 e2e local under the lock (waited ~16 min on #358, clean) ·
>   review 0 Blockers, 12 findings actioned. One red CI round, fixed
>   (0a4ea71): a test driving the real e2e globalSetup implicitly
>   asserts the machine's build state — CI runs npm test before build,
>   so no out/ exists; now asserts delegation, reason written in.
>   Discoveries: stale-lock gotcha (`tasklist | grep -c` returns 0 with
>   electron live — READ LINES; skill updated) · sweeper census comment
>   slightly stale in a good way · CHANGELOG fourth strike (→ #353).
>   Handoff: 360.md.
>
> **Branding ✅ MERGED:** **PR #362** (#361) → squash **7fe7689**, issue
> closed, branch deleted. Dan's WIP ("switchboard" → "switchboard.ai" in
> window title, i18n, notifier fallback, installer shortcut/Add-Remove;
> exe name and %APPDATA%\switchboard deliberately unchanged), committed
> at his instruction. Orchestrator gates before push: lint/typecheck
> clean · 2645 unit · about+boot specs 5/5 under the lock on a fresh
> build; CI 4/4 green before merge. Main checkout tree is clean again
> except PROGRESS.md + the /orchestrate SKILL.md edits (orchestrator's,
> committed at run close).
>
> Orchestrator: Fable (/orchestrate). **Single-writer rule:** this file is
> written ONLY by the orchestrator session. Workers report via handoff files
> in `.claude/work_files/orchestrator/<issue#>.md`; handoffs are the inputs,
> this file is the output. If this session dies, a fresh /orchestrate
> session resumes from THIS block.
>
> **Active workers (wave 1 = the whole filed queue, all dispatched
> 2026-08-08):**
> - **#352** ✅ DONE (~44 min) → **PR #356 READY, IN DAN'S QUEUE** (UF —
>   on-disk behavior + manual paragraph; **CI 4/4 GREEN** confirmed).
>   Fix shape: `load()` holds the corrupt bytes (Buffer, 4 MB cap); a
>   failed set-aside arms a pending rescue that `save()` runs first —
>   write held bytes (`wx`) XOR copy (`COPYFILE_EXCL`), then MOVE the
>   damaged file aside (works on a full disk; safe only there because
>   the save is one statement from destroying it anyway). All routes
>   refuse existing names (#349's guarantee centralized). All-fail →
>   save held back, retry at 1s, budget 5 saves, then live workspace
>   wins with a loud warn. Fail-open throughout; quit-flush deferral
>   bounded + argued in code. Bonus pre-existing fix: `save()`'s warn
>   was unguarded — a throwing logger reached the close handler. Review
>   round's demanded test found a REAL bug pre-push (`writeNew` cleanup
>   deleted a destination it hadn't created — Windows answers hidden/
>   read-only with EPERM not EEXIST; fixed + pinned). Gate: lint/
>   typecheck clean · 2565 unit (+12) · local e2e skipped (stated call,
>   main-process fs only, same as #349) but CI e2e green both platforms ·
>   10 mutation checks red-verified. Manual: 11-troubleshooting rewritten
>   pre-PR (old sentence documented the data loss). Discoveries: CHANGELOG
>   gap → commented on #353 (now owes #352+#355 entries too); narrow
>   stranded-truncated-copy path (both write AND cleanup must fail —
>   left, cost>benefit); #207 remains the surfacing half. Handoff: 352.md.
> - **#355** ✅ DONE (~38 min) → **PR #357 READY, IN DAN'S QUEUE** (UF;
>   CI pending at last check). Renderer-only: card `exited` state became
>   `ended` union (`exited` | `never-started`); never-started reads
>   "Session didn't start" + hint + **Try again** (not "Restart"), via 3
>   new i18n keys; exited copy untouched. Pure `endedCopy()` mapper unit-
>   pinned (+4, words not just keys); +1 e2e (missing seedFolder → new
>   heading, zero old copy) — mutation-proved incl. the wiring revert.
>   Gate: lint/typecheck clean · 2557 unit · 199+1 e2e (lock first-try,
>   owner 355). Manual: 11-troubleshooting retitled + 02-sessions, pre-PR.
>   Discoveries: **#358 filed** (overlays have no aria-live — pre-existing
>   a11y gap); CHANGELOG gap re-hit (→ #353; worker suggests orchestrator
>   opens `0.1.3 — unreleased` centrally once — for Dan at merge/release);
>   refusal *reason* can't reach the screen (null carries nothing —
>   adjacent to #346's contract decision, noted there, not filed). e2e
>   flake watch: 2 runs × 1 different >25s bring-up timeout each
>   (split.spec, feed.spec), both green isolated — machine load from 3
>   workers, not worth an issue yet. Handoff: 355.md.
> - **#354** ✅ DONE (~48 min) → **PR #359 (INTERNAL) — awaiting green CI,
>   orchestrator merges.** Placement decision (the item's real content):
>   the sweep is NOT app-side — sb-ws- is written only by store.test.ts,
>   every sb-* producer is test/fixture/probe, and a shipped app deleting
>   dirs it never created fails the PHILOSOPHY §4 litmus outright (argued
>   divergence from the issue's stated candidate, spelled out in the PR).
>   Shipped: `scripts/sweep-temp-orphans.js` + `npm run sweep:temp` CLI +
>   vitest globalSetup (2s budget, SB_SKIP_TEMP_SWEEP opt-out via isOn).
>   Envelope: direct children of tmpdir only, exact mkdtemp shape regex,
>   dirent isDirectory (symlinks/junctions skipped), >24h, fs-root
>   refused, never throws. Gate: lint/typecheck clean · 2629 unit (+76) ·
>   e2e skipped locally (stated call, scripts+config only) CI runs it ·
>   19 mutations red-verified · review 0 Blockers, 14 findings all
>   actioned (2 were FALSE load-bearing comments: updater DOES stage in
>   tmpdir; dir mtime does NOT move on inner writes). Internal doc:
>   testing.md "Temp directories" block. Discoveries → **#360 filed**
>   (raw mkdtempSync files outside #213's registry + e2e seam doesn't
>   sweep); s11 >24h soak named as the one thing that could outlive the
>   floor. Handoff: 354.md.
>
> ⚠️ **INCIDENT (reported, resolved, process gap closed):** #354's
> code-reviewer SUBAGENT ran the unbudgeted sweep CLI against the live
> %TEMP% (not a fixture) and deleted ~81,600 directories before being
> killed. Assessment: NO LOSS — every one matched the orphan filter and
> was >24h old, i.e. exactly what `npm run sweep:temp` deletes and what
> Dan's own hand-test step 2 would have removed; the pile is now ~31k,
> so the PR's hand-test numbers read smaller than the census figures
> (which are labelled as a 2026-08-08 census and remain accurate).
> Root cause: the worker's fixtures-only clause was never restated in
> the reviewer subagent's prompt. **Fix landed in the /orchestrate
> skill** (worker contract §4): subagents inherit every safety
> constraint verbatim.
>
> Collision notes: #352 (workspace store.ts + store.test.ts) vs #354 (test
> temp-dir infra) may both brush store.test.ts — merges serialize, rebase
> surfaces it. All three may touch manual 11-troubleshooting.md in
> different sections (auto-merge expected, same as run 9). #355 is
> sessions ipc / renderer / i18n — no code overlap with the other two.
> Base for all three branches: main @ 3e25368. e2e lock clear at run start.
>
> **CLOSE-OUT:** all 3 items landed first try; zero lock steals, zero red
> pushes, zero rate-limit warnings, zero worker casualties (one incident:
> #354's reviewer subagent — block below, gap closed in the /orchestrate
> skill). **✅ FULLY MERGED (Dan authorized, 2026-08-08):** PR #356
> (#352, UF, 4/4 green → squash f4bb8ce) · PR #357 (#355, UF, 4/4 green
> → squash 8f50a53) — individual squashes, NO train needed
> (11-troubleshooting auto-merged as predicted, zero bumps, zero
> conflicts) · PR #359 (#354, internal → squash 6a3ab32, merged in-run).
> Issues #352/#354/#355 closed, branches deleted local+remote. **Main @
> 8f50a53, out/ REBUILT, stamp 8f50a53 verified both bundles — `npm
> start` is current.** Hand-test lists remain in the PR bodies /
> 352.md + 355.md for post-merge testing. **⚠ NOTE: Dan's uncommitted
> branding WIP ("switchboard" → "switchboard.ai": index.html title,
> en.json strings, electron-builder shortcutName/uninstallDisplayName,
> about/boot specs, main/index.ts) predates the run, was preserved
> across the merges (stash→pull→pop; en.json auto-merged cleanly), and
> is STILL UNCOMMITTED in the main checkout — the rebuilt out/ includes
> it. Nobody's issue yet; Dan to commit or park it.** Issues filed from
> discoveries: **#358** (ended/never-started overlays silent to screen
> readers — aria-live) · **#360** (temp-dir test hygiene: raw
> mkdtempSync files outside #213's registry + e2e seam doesn't sweep);
> #353 got a run-10 comment (CHANGELOG now owes #352+#355 entries too).
> Worktrees: all three detached and clean — ready for next-run
> checkouts off fresh main.
>
> **Queue for the NEXT run:** **#360** (internal, independent) ·
> **#358** (UF, renderer ended-overlay surface — UNBLOCKED now that
> #357 is merged; no overlap with #360, the two can run in parallel). **#346** (broker refusal contract) and
> **#353** (release-cut checklist incl. CHANGELOG backfill + opening
> `0.1.3 — unreleased`) remain Dan's decisions/actions.
>
> **Held/decisions (Dan's standing list, untouched):**
> **#346** (broker refusal contract — decision for Dan; #345+#351 set the
> null-result precedent, recommend result-shape) · **#353**
> (next-release-cut checklist — do at the next release cut) · #80 #111
> #255 #268 #269 #290 #292 #295 #216 #207 #200 #191 #129 #256(epic) #320
> #323 #313 #333 #337 #344-surfacing.

> # 🎛 RUN 9 CLOSED 2026-08-08 + FULLY MERGED
> (~1.6 h run + same-morning merge). **Both queue items shipped and
> ON MAIN: #349 → PR #350 (squash 4a9db4c) and #347 → PR #351
> (squash 62cd57d), both UF, both 4/4 green, Dan authorized "merge
> them" — individual squashes, NO train needed (zero file overlap,
> zero bumps, zero conflicts). Issues #349/#347 closed, feature
> branches deleted local+remote. Main @ 62cd57d, out/ REBUILT,
> stamp verified both bundles — `npm start` is current. 4 issues
> filed from discoveries (#352 #353 #354 #355). Dan's stated next
> step: context-clear + fresh /orchestrate.**
>
> **Queue for the NEXT run (in suggested order):** **#352**
> (set-aside FAILURE path eats evidence — unblocked, #350 is in;
> store.ts) · **#354** (pre-#213 sb-ws-* orphan sweep — unblocked,
> #351 is in) · **#355** (refused-vs-died overlay copy + i18n — UF,
> renderer distinction; SessionGrid/ipc, so NOT concurrent with
> #352? no — #352 is store.ts, fine; run #355 and #352 in
> parallel, #354 in the third slot if no session-manager overlap
> with #355, else serial after it). **#346** = decision for Dan
> (broker refusal contract; #345+#351 both set the null-result
> precedent — recommend result-shape). **#353** = next-release-cut
> checklist (CHANGELOG backfill for ALL post-0.1.2 merges incl.
> #350/#351 + correct 0.1.2's stale filename note + make "open
> next unreleased section" a release step). Zero lock steals, zero
> red pushes, zero rate-limit warnings, zero worker casualties.
>
> **Single-writer rule:** this file is written ONLY by the orchestrator
> session. Workers report via handoff files in
> `.claude/work_files/orchestrator/<issue#>.md`; handoffs are the inputs,
> this file is the output. If this session dies, a fresh /orchestrate
> session resumes from THIS block.
>
> **Queue (run-9, final):** wave 1 was the whole run — **#347**
> (sb-wt-1) + **#349** (sb-wt-2), dispatched in parallel, no file
> collisions, both landed first try. Held/decisions untouched
> (Dan's standing list): #80 #111 #255 #268 #269 #290 #292 #295
> #216 #207 #200 #191 #129 #256(epic) #320 #323 #313 #333 #337
> #344-surfacing. Main @ f14b559 all run (nothing merged).
>
> **✅ MERGED (Dan-authorized, 2026-08-08):** **PR #350** (#349,
> UF, 4/4 green → squash 4a9db4c) · **PR #351** (#347, UF, 4/4
> green → squash 62cd57d). Hand-test
> lists in the PR bodies / 349.md + 347.md. Train-conflict watch:
> NONE — #350 (store.ts/manual-workspace pages) and #351 (sessions
> ipc/manager/manual-sessions pages) share no files; both touch
> 11-troubleshooting.md but different sections (auto-merge
> expected).
>
> ✅ **#347 → PR #351 READY, IN DAN'S QUEUE (worker, ~45 min; UF —
> one refusal IS reachable by an ordinary gesture: a restored
> card whose folder was renamed/deleted/unplugged calls
> sessions:create via resume-on-focus; visible behavior unchanged
> ["Session ended" overlay] but previously the reason went to
> stderr, which main does not capture — the log never named the
> folder. Now it does).** Swept all 24 sessions-family
> registrations: only sessions:create + sessions:rename threw —
> both now refuse → null + warn (channel, reason, cardId/folder);
> manager.create wrapped (its 3 deliberate throws +
> buildHookSettings + PtyService.spawn by construction);
> SessionManager.mustGet deleted (kill/rename log-and-drop, the
> throw was the class outlier). Post-spawn wiring left throwing on
> purpose (session live by then, null would strand it). Preload
> type widened to `| null` — the TYPE SYSTEM pins the renderer's
> null branch (mutation: typecheck red ×5). Manual:
> 11-troubleshooting new entry + 02-sessions pointer, written
> pre-PR. Gate: lint/typecheck clean · 2542 unit (+21) · 199+1 e2e
> (8.2m, lock first-try, owner 347) · 5 mutation reverts red incl.
> the e2e pageerror probe (proves it non-vacuous). Trap
> re-confirmed: NO global unhandledrejection handler (comment at
> the probe). Discoveries → **#355 filed** (overlay says "Exited
> unexpectedly (code -1)" for a never-started session —
> refused-vs-died + copy + i18n), CHANGELOG gap folded into #353
> (comment added: every post-0.1.2 merge shares it; make "open
> next unreleased section" a release-skill step). Handoff: 347.md.
>
> ✅ **#349 → PR #350 READY, IN DAN'S QUEUE (worker, ~43 min; UF —
> filename on disk + retention policy + manual sentences changed).**
> Fix shape: write-once timestamped set-asides
> (`workspace.json.corrupt-<iso>`, `:`→`-` for Windows,
> COPYFILE_EXCL), cap five with **the OLDEST spared on purpose** —
> "keep five newest" reintroduces #349 on the sixth bad launch
> (review Blocker, fixed both in code and manual). Rejected numbered
> rotation (renames existing files on the exact path that runs when
> the disk is misbehaving) and the bare don't-overwrite guard
> (strands the first corruption forever). Prune runs only after a
> landed copy, only over names this code wrote (prefix + stamp regex
> + isFile); justWritten excluded so a backwards clock can't delete
> the copy it just logged. #348's warn-idiom kept (setAside/pruned
> full paths, split pruneListError vs pruneError). Manual
> 11-troubleshooting + 07-workspace updated pre-PR — including
> fixing THREE sentences shipped false in 0.1.2 (#348's merge-time
> touch-up list was dropped; process miss, noted). Gate: lint/
> typecheck clean · 2532 unit (+11) · e2e skipped locally (stated
> call, main-process fs only) but **CI 4/4 green incl. e2e both
> platforms** · 7 mutation checks red-verified. Discoveries →
> **#352 filed** (set-aside FAILURE path: first saveSoon overwrites
> the only copy — pairs with held #207), **#353 filed** (next
> release: CHANGELOG entry + correct 0.1.2's stale filename note),
> **#354 filed** (~7,600 pre-#213 sb-ws-* orphans in %TEMP%, nobody
> sweeps). Handoff: 349.md.
>
> # 🎛 RUN 8 CLOSED 2026-08-07 (~3.5 h). **9 items:
> 2 internal MERGED (#306→#322, #329→#335), 7 user-facing PRs in
> DAN'S QUEUE (#324 #325 #328 #330 #332 #336 #338 — **ALL SEVEN
> 4/4 GREEN**, #338 confirmed on the close-out check). All 7 core queue items done PLUS two
> same-run discoveries (#327, #329) dispatched and done. 9 issues
> filed from discoveries (#323 #326 #327 #329 #331 #333 #334 #337
> #339), 2 of them fixed same-run. Main @ fb3076f, out/ REBUILT +
> stamp fb3076f4 verified in both bundles — `npm start` is current.
> Suggested train order: #332 → #338 → #336 → rest any order;
> conflict watch: stream.spec.ts + 12-direct-mode.md (#332×#338,
> keep-both/adjacent), hook-listener.ts (#338 ingest × #336 type
> re-export, different regions). Zero lock steals, zero red pushes,
> zero rate-limit warnings, zero worker casualties. One honesty
> note: #313's worker self-flagged ~3 throwaway real-token CLI
> turns (ran check:adapter/hooks/transcripts unprompted while
> checking what CI runs; no probe attempted). Backfill now gated on
> the train: #334 + #333 (hook/stream files under 2 unmerged PRs),
> #326 (PR #325's test file), #331 (documents PR #330's repairs),
> #339 (stream.spec under 2 unmerged PRs), #337 (paired with held
> #269).**
>
> **Single-writer rule:** this file is written ONLY by the orchestrator
> session. Workers report via handoff files in
> `.claude/work_files/orchestrator/<issue#>.md`; handoffs are the inputs,
> this file is the output. If this session dies, a fresh /orchestrate
> session resumes from THIS block.
>
> **Queue (run-8):** the 7 run-7 discoveries. Wave 1 (dispatched):
> **#319** (stream holds fail-open + server-side allow-all, UF,
> sb-wt-1, feature/319-stream-hold-failopen) · **#311** (group rename
> guard, UF, sb-wt-2, feature/311-group-rename-guard) · **#306**
> (popout flex pin, INTERNAL, sb-wt-3, feature/306-popout-flex-pin).
> Backfill order: #314 (aria-live) → #315 (withdrawn-release reason)
> → #313 (Notification status guard — stream track, AFTER #319
> pushes) → #312 (IdentityChip — AFTER #319 pushes; both touch
> SessionGrid.tsx). Train-conflict watch: #319×#313 (stream.spec.ts
> appends, keep-both, #319 first). Held/decisions (untouched, Dan's
> standing list): #80 #111 #255 #268 #269 #290 #292 #295 #216 #207
> #200 #191 #129 #256(epic) #320, + prettier adopt/drop.
>
> **🚂 ✅ TRAIN #340 MERGED 2026-08-07 (~14:41 local) — main @
> e844afb.** ONE CI run, 4/4 green FIRST TRY. All 7 member PRs
> (#324 #325 #328 #330 #332 #336 #338) flipped to merged, all 7
> issues (#314 #311 #315 #327 #319 #312 #313) closed, all 7 feature
> branches + train branch deleted (local + remote). Main checkout
> REBUILT, stamp e844afb7 verified in both bundles — `npm start` is
> current. Train mechanics for the record: ONE conflict total
> (stream.spec.ts, #332×#338 interleaved appends — resolved by
> rebuilding the tail with each describe block taken WHOLE from its
> source branch); hook-listener.ts + 12-direct-mode.md auto-merged
> clean; targeted overlap check post-#338 133/133; full train gate
> lint/typecheck clean · 2463 unit / 118 files · 199+1 e2e (7.4m)
> under the lock.
>
> **🎉 v0.1.2 LIVE (2026-08-08 ~09:45) — RUN 8 FULLY CLOSED, ZERO
> OPEN PRs, CONTEXT-CLEAR-READY.** Dan authorized "merge 343 as is"
> + a dogfood release: PR #343 merged (bump + re-green, issue #331
> closed — last open PR), then release commit ead4db4 (version
> 0.1.2 + user-worded CHANGELOG section for the whole run; the
> release-notes guard passed 45/45 locally AND a real
> `release-notes.js --ref refs/tags/v0.1.2` extraction dry-run
> BEFORE tagging), tag v0.1.2, workflow run 31259626913 SUCCESS
> first try: switchboard-Setup-0.1.2.exe + .sha256 + notes,
> published (not draft) —
> https://github.com/badsonstudios/switchboard.ai/releases/tag/v0.1.2
> Laptop dogfood: download the installer from that page, or any
> 0.1.1 install's in-app Update button offers 0.1.2 (E19-04 path,
> proven live on 0.1.0→0.1.1). A fresh /orchestrate session resumes
> from THIS block: dispatchable next = #347 (sessions-family throw
> sweep, template PR #345) + #349 (.corrupt retention); all else
> Dan-gated (decisions: #323 prettier, #313 live probe, #333
> routing, #337×#269 accents, #207+#344 surfacing, + standing
> list). Worktrees detached+clean. Main @ ead4db4 (release commit;
> code tree = d6acadb + docs #343).**
>
> **🎛 RUN 8b CLOSED 2026-08-07 (~16:10). ALL FOUR backfill
> internals MERGED serial-chain on green (#341→#334, #342→#339,
> #345→#326, #348→#344; two bumps, zero failures). Main @ d6acadb,
> out/ REBUILT, stamp d6acadb8 verified both bundles. ONE open PR
> repo-wide: #343 (#331 docs, DAN'S QUEUE — at merge time 3
> sentences in 11-troubleshooting.md + 1 in 07-workspace.md go
> false because #348's logging landed; exact rewrites in 344.md
> §touch-up; sb-wt-1 parked detached, feature/331 branch ref kept
> alive for the PR). Worktrees all detached+clean. Everything else
> open is Dan-gated: decisions #323 (prettier — no config
> resolves), #313 live probe, #333 routing, #337×#269 accents,
> #207+#344 surfacing half, #349 (.corrupt overwrite), + standing
> list #80 #111 #255 #268 #269 #290 #292 #295 #216 #207 #200 #191
> #129 #256 #320. Run-8 totals incl. train + backfill: 13 items
> shipped (7 UF via train #340, 6 internal direct), 13 issues
> filed (#323 #326 #327 #329 #331 #333 #334 #337 #339 #344 #346
> #347 #349), 5 of them fixed same-run (#327 #329 #331 #334→#344
> chain #339), zero lock steals, zero red pushes, zero rate-limit
> warnings.**
>
> ✅ **#344 → PR #348 READY (worker, ~23 min; INTERNAL — in merge
> chain).** Every repair on 331.md's table now warns in the
> module's idiom: .corrupt set-aside logs the caught error WITH
> STACK + set-aside path (+ copy-failure fallback), dropped
> sessions/groups with counts, orphaned ids (capped 20), bad
> window rect, defaulted prefs by key, non-boolean autoTrust.
> Deliberately silent: first launch, absent/null fields,
> future-version files (not damage). Structural catch from
> self-review: warns COLLECTED and emitted AFTER the try/catch —
> a throwing logger inside the try would have been caught by the
> corrupt-file handler and wiped the workspace it was diagnosing
> (latent before this PR); sanitizers stay pure via
> {value, repaired}. Gate: 2483 unit (+20), 7 warn sites
> mutation-checked (1–3 red each); e2e skipped (main-process
> log-only, stated call). Discovery → **#349 filed** (.corrupt
> overwritten on every failed load — two bad launches lose the
> first post-mortem). Handoff: 344.md.
>
> ✅ **#326 → PR #345 READY (worker, ~25 min; reclassified INTERNAL
> with evidence — merge on green).** Shape chosen: NON-THROWING
> RESULT SHAPE for the whole groups:* family (refused mutation
> resolves null, never throws) — safe by CONSTRUCTION for the next
> caller, and null is data the renderer can react to; a
> .catch(log) only stops the crash. group-ipc was already half in
> the house shape (only the validation branches threw). Rejected a
> renderer-wide unhandledrejection handler — it would have made
> #311's pageerror assertion vacuous (the trap the whole
> "just stop the crash" family walks into). Not swallowed: main
> warns channel+reason; renderer warns at groupChangeLanded; call
> sites refresh so a refused edit reverts to truth. #325's guards
> intact. INTERNAL because no gesture can reach a refusal today
> (create=constant, recolor=palette, rename=#325-guarded) — manual
> stays accurate word-for-word. Gate: 2498 unit (+35) / 199+1 e2e
> (7.7m, lock first-try); 5 mutations red incl. the e2e probe.
> Discoveries → **#346 filed** (broker throws 'refused:' on every
> channel — wrong contract for Phase-4 plugins) + **#347 filed**
> (sessions:create/session-manager same throw class — sweep with
> #345 as template). Handoff: 326.md.
>
> ✅ **#331 → PR #343 READY, IN DAN'S QUEUE (worker, ~4 min; UF
> docs-only, +45/−0).** Two troubleshooting entries (unreadable
> file → .corrupt set-aside; field repairs) + a 07-workspace.md
> cross-ref — every claim verified against store.ts, NOT the
> issue text, which was wrong twice: (1) only the blank-group-name
> repair logs; every other repair is SILENT (docs say so honestly);
> (2) the .corrupt set-aside logs NOTHING — void err; at
> store.ts:246, no banner, nothing surfaced ("my workspace is
> suddenly empty" with zero explanation). → **#344 filed** and
> dispatched same-run (log-only scope; Events-surface half parked
> with held #207). Gate: lint/typecheck clean, 2463 unit, tree
> untouched by design. NOTE: if #344 lands, #343's "silent"
> sentences need a merge-time touch-up (tracked in 344's brief).
> Handoff: 331.md.
>
> ✅ **#339 → PR #342 READY (worker, ~13 min; INTERNAL — merge on
> green).** startingLong was vacuous TWO ways: (a) the transport-
> ready fix means starting ends <1s so the guard was never reached
> (final fall-through returned null); (b) the absence assertions
> ran with the Terminal tab selected — the Session panel that
> renders the bar wasn't even mounted (this half wasn't in
> 313.md). Mutation MEASURED: guard deleted → old body PASSED,
> retargeted body FAILED at [data-handoff] 0→1. Now pins: restart
> into Direct → real hook out of the restarted child's own
> --settings → needs-input reached → bar/button/prose absent; also
> the only proof a restarted-into-Direct session has a live hook
> channel. startingLong itself kept teeth via a new FeedView
> panel-contribution unit case (fake timers, same-mutation red).
> Test-only; product NOT broken. Gate: 2464 unit / stream.spec 20
> passed (49.9s) targeted (stated call; CI runs full). Handoff:
> 339.md.
>
> ✅ **#334 → PR #341 READY (worker, ~10 min; INTERNAL — merge on
> green, CI running).** noWindowWarned now re-arms the moment the
> liveness gate confirms a live window — in BOTH channels
> (HookListener.maybeHold + StreamPermissions.offer): the worker
> found the ISSUE'S PREMISE WRONG (StreamPermissions did NOT
> re-arm on window return; both channels were symmetric-wrong,
> cleared only at session teardown) and fixed both under the
> files' written no-drift invariant. Also corrects #319's handoff
> note 3 (no leak — unregisterSession has cleared per-session
> since #113; strike that note if handoffs are kept as knowledge).
> +2 unit (2465), mutation: each revert reds exactly its two
> tests. e2e skipped (log-level only), no lock. Handoff: 334.md.
>
> **Active workers: NONE — run closed.** Worktrees clean, parked on
> their pushed refs (sb-wt-1 feature/313-…, sb-wt-2 feature/312-…,
> sb-wt-3 detached at dfa316b); rebase onto fresh main after the
> train lands. **Merge queue:** empty (both internals merged
> in-run). **Dan's queue (7 UF PRs):** #324 (#314) · #325 (#311) ·
> #328 (#315) · #330 (#327) · #332 (#319) · #336 (#312) · #338
> (#313). Decisions owed (new this run): #323 prettier — now
> CONCRETE: prettier resolves NO config here, --write would
> mass-rewrite; #313's live-probe question (shipped defensive;
> probe still open, pairs with hook-listener.ts:633); #333 routing
> shape; #337×#269 pairing. Standing list unchanged: #80 #111 #255
> #268 #269 #290 #292 #295 #216 #207 #200 #191 #129 #256(epic)
> #320.
>
> ✅ **#313 → PR #338 READY, IN DAN'S QUEUE (worker, ~44 min; UF —
> last core item).** Producer-side, as endorsed: HookListener.ingest
> no longer feeds a permission-classified Notification into
> manager.apply() for a stream session (debug-logged like :639's
> hold suppression); classifier lifted out of state-machine.ts as
> isPermissionNotification so the layers can't drift. :176
> hardening DECLINED with rationale IN THE FILE: requiring a held
> request is actively wrong on PTY — that arm is the only
> permission signal when hold policy deliberately passed the call
> (plan mode, full-auto, outside PRETOOL_MATCHER); it would trade a
> nuisance amber badge for a silently wedged session. BIG catch en
> route: the fake stream adapter SILENTLY DROPPED options.settings
> — every Direct e2e since P2-E18-04 ran against a HOOK-LESS child;
> seam fixed (fake now passes --settings; !notify runs the real
> forwarder synchronously). #261's e2e retargeted needs-permission
> → needs-input (its old target is the state this change removes).
> Mutation: guard→if(false) = 3/10 unit + e2e red at the exact
> claim. #332 overlap: no shared source files; the two suppressors
> COMPOSE (stream permission-held path vs hook Notification path).
> Gate: 2383 unit / 198+1 e2e (~14 lock waits behind #312, no
> steal); check:pty + check:fake-stream PASS; CI settling at close.
> Self-flagged: ~3 throwaway real-token turns (check:adapter/hooks/
> transcripts) — disclosed, no probe attempted. Discovery → **#339
> filed** (startingLong passes for the wrong reason). Handoff:
> 313.md.
>
> ✅ **#329 → PR #335 READY (worker, ~27 min; INTERNAL — orchestrator
> merges on green).** Stale-bundle guard moved to Playwright
> globalSetup (scripts/e2e-global-setup.js) — the one seam NO
> invocation routes around; CALLS a new in-process twin of
> guardBundle (no forked logic); e2e:only/e2e:ui dropped their own
> guard call (one seam, one banner). Proof on a genuinely stale
> out/: npx playwright test exited 1 in 2.4s, zero specs run; after
> build, FRESH + pass. Guard cost 44ms. e2e:ui removal verified
> against Playwright's own runner source (globalSetup wired into
> both CLI and UI-mode paths). Gate: 2382 unit (+15) / 197+1 e2e
> (two sharded full runs through the new setup), lock first-try, no
> steal. Noted, not filed: CI e2e logs now carry the build stamp
> (deliberate); ALLOW_STALE_BUNDLE=1 now silences EVERY Playwright
> invocation (wider blast radius — never bake it into a runbook);
> manual pages still say "Status: draft" (#260's standing flag).
> Handoff: 329.md. → **MERGED on 4/4 green (main @ fb3076f), issue
> closed, branches deleted (local delete needed sb-wt-3 detach
> first — worktree held the ref).** The #312 worker's stale-bundle
> gotcha (first mutated e2e run passed misleadingly off npx's
> no-rebuild) independently CONFIRMS this guard's value — that trap
> is now closed on main.
>
> ✅ **#312 → PR #336 READY, IN DAN'S QUEUE (worker, ~28 min; UF).**
> Card tabs now paint the real accent + language badge — new store
> getters getCardAccent/getCardBadge (store read, not a CardParams
> thread, per spec; two SCALAR getters deliberately — a fresh
> object per call loops useSyncExternalStore forever). Grey
> fallback preserved + tested. DTO fold-in: the permission shape
> existed in THREE hand-written drifted copies (main/preload/
> renderer) — now one src/shared/ipc/permissions.ts, hook-listener
> re-exports so ~8 importers untouched; runtime-neutrality PROVEN
> (preload bundle byte-identical, main differs only by build
> timestamp). Mutation ×4 configurations red; e2e added cheaply on
> tabs.spec's existing 7 sessions (asserts distinctness, not named
> colours; revert → all 7 tabs one colour). Zero file overlap with
> PR #332 — train-safe either direction. Gate: 2376 unit / 197+1
> e2e under the lock (clean handover to #313). Manual:
> 02-sessions.md. Discovery → **#337 filed** (rail hand-rolls its
> identity dot — the 'ONE way identity renders' contract still
> false one surface over; sequenced with held #269). Note: card tab
> now shows accent at 8px — #269's blast radius grew by one surface
> (aria-hidden, no text). Handoff: 312.md.
>
> ✅ **#319 → PR #332 READY, IN DAN'S QUEUE (worker, ~73 min; UF —
> the run's centerpiece).** (a) StreamPermissions gained
> hasLiveWindow (gate at offer), a 300s deadline, and releaseHeld —
> all resolving DENY (a can_use_tool has no "no opinion" answer);
> onRendererLost releases both channels, each in its own try/catch;
> hasLiveWindow is one shared expression so the channels can't
> drift. (b) sessions:allowAllSession now tells StreamPermissions;
> permission-held suppression lives at the status apply
> (SessionManager.setPermissionHoldSuppressor) — allow-all Direct
> sessions: no banner, no beep, no per-call Events entry, no
> renderer needed. Deliberate divergence (documented in-code):
> allow-all applies NO status event (mirrors hook path's 'answered')
> — resolving defensively could walk a session out of
> needs-permission while a DIFFERENT question was outstanding.
> Self-review caught the no-window denial masquerading as
> "sandbox blocked me" — both fail-open paths now share
> unavailable(). Teeth measured: new e2e passes at 0
> needs-permission frames, fails with 5 on suppressor revert; 6
> unit guards mutation-checked. Gate: 2389 unit (+27) / 198+1 e2e;
> ~25 min in-turn lock wait behind #311/#315, zero steals; CI
> in flight at handoff. Manual: 04 + 11 + 12. Discoveries →
> **#333 filed** (no-card-mapping request decays via deadline —
> real fix is routing) + **#334 filed** (HookListener.noWindowWarned
> never re-arms). Handoff: 319.md.
>
> ✅ **#327 → PR #330 READY, IN DAN'S QUEUE (worker, ~8 min; UF
> edge-case repair).** Repair, not reject — store.ts's own posture
> settled it (drops structural garbage, repairs recoverable fields;
> dropping the group would silently ungroup every member session —
> fail-open P6). New repairGroupName() + PLACEHOLDER_GROUP_NAME
> ('Untitled group') as a .map() on the existing load() filter, warn
> names the group id; isSaneGroup itself unchanged (a filter type
> guard can only reject — the issue title's shape was wrong, the
> invariant closes one line later). +6 store.test.ts (mutation ×2:
> 4-red and 1-red). Gate: lint/typecheck clean, 2373 unit; e2e
> skipped (hand-edited-file trigger, seam covered incl. disk
> round-trip), lock untouched. No manual page (nothing documents
> corruption today) → **#331 filed** (troubleshooting section for
> BOTH corruption paths: .corrupt set-aside + load repairs). Noted,
> not filed: group names not unique-constrained (two blanks both
> read 'Untitled group'); zero-width chars pass trim(); IPC-vs-load
> bounding asymmetry. Handoff: 327.md.
>
> ✅ **#315 → PR #328 READY, IN DAN'S QUEUE (worker, ~36 min; UF).**
> Shape chosen on the merits (no Dan question): distinct 'no-offer'
> reason on the update contract, NOT a press-time re-check (a
> re-check would install whatever the feed answers NOW, not the
> release whose notes the user agreed to). Decision moved out of the
> update:install IPC handler into exported pure resolveOffer() —
> index.ts is the one file the unit suite can't import, which is why
> the branch was untested. One reason covers withdrawn/superseded/
> unreachable-feed; the log line keeps the distinction. The existing
> "all eight sentences distinct" Set assertion now actually proves
> the no-asset case is distinguishable (it was previously satisfied
> by the lie). Gate: 2367 unit / 197+1 e2e under the lock (waited
> 1 min for #311's lock, clean handover). No e2e added — stated
> call: reproducing needs main's lastResult() to move while the
> renderer's copy doesn't; only the hourly timer does that. Manual:
> 13-updates.md new section + the #314-sibling screen-reader line
> (worded to match PR #324, read via gh pr diff — no file overlap).
> Discovery → **#329 filed** (npx playwright test silently tests a
> stale bundle — cost the worker a 9-min red run; globalSetup guard).
> Handoff: 315.md.
>
> ✅ **#311 → PR #325 READY, IN DAN'S QUEUE (worker, ~36 min; UF).**
> The issue's premise was HALF WRONG: main's groups:update always
> refused/trimmed blanks (unlike #294's sessions:renameCard), so ''
> was never persistable and the unrenameable-group scenario was
> unreachable. The REAL bug: the empty draft hit a throwing handler
> over App.tsx's uncaught void-then → unhandled renderer rejection
> (proven with a Playwright pageerror probe). Fix: rail field trims +
> refuses blanks (Escape's idiom, matching its sibling); no redundant
> second main guard — the seam got its first-ever test file instead
> (group-ipc.test.ts, 9 tests) + 5 rail tests + groups e2e extended.
> Worker's testing insight worth keeping: on a two-layer guard, an
> e2e "bad thing didn't happen" assertion only witnesses the OUTER
> layer (it passed with the rail guard reverted) — pageerror is what
> witnesses the renderer layer. Gate: 2376 unit / 197+1 e2e (lock
> clean handover to #315). Manual: 07-workspace.md. Discoveries →
> **#326 filed** (App.tsx bridge calls have no .catch(); groups:* is
> the family that throws) + **#327 filed** (isSaneGroup accepts ''
> on load — hand-edited workspace.json can still make the zero-width
> button). Flake note: palette.spec.ts:120 flaked once under load,
> passed isolated — second spec seen doing this; watching, not filed.
> Handoff: 311.md.
>
> ✅ **#314 → PR #324 READY, IN DAN'S QUEUE (worker, ~6 min; UF/a11y).**
> role="status" + aria-live="polite" on the E8-06 reconnect offer's
> message div, identical idiom to the update notice; 4 new pins in
> a11y-surfaces.test.tsx cover the offer AND both update-notice
> flavours (mutation-checked ×2 red). Gate: lint/typecheck clean,
> 2366 unit; e2e not run (nothing drives the offer without a real OS
> display event), lock untouched. Manual: 07-workspace.md. Out-of-
> scope note: 13-updates.md lacks the sibling a11y one-liner —
> folded into #315's manual scope (same page) rather than filed.
> Handoff: 314.md.
>
> ✅ **#306 → PR #322 DONE (worker, ~12 min).** Roster+completeness
> scan extended to popout.html's body column (5 new tests, 7/7
> mutations red→green); the workspace-div comment landed (note: the
> load-bearing flex:1 drifted App.tsx:959→1064 since #274). Judgement
> call: popout.html untouched, test accepts equivalent no-shrink
> spellings. Gate: lint/typecheck clean, 2367 unit; e2e not run
> (test-file + comment only, per carve-out), lock never taken.
> Discovery → **#323 filed** (prettier resolves NO project config —
> --check fails on the unmodified base; feeds the standing prettier
> adopt/drop decision). Handoff: 306.md.
>
> ---
>
> # (closed) 🎛 RUN 7 CLOSED 2026-08-06 (~5.5 h). **10 items:
> 3 internal MERGED (#280→#304, #284→#317, #300→#316*), 5 user-facing
> PRs in DAN'S QUEUE (#305 #307 #308 #309 #318), #255 measured-only
> (161 errors, decisions on the issue), plus Dan's LIVE mid-run bug
> (#310) diagnosed→filed→fixed same run. 9 issues filed from
> discoveries (#306 #311–#315 #319 #320 + #310 itself), 1 fixed
> same-run. *Residual mechanics: GitHub's LINUX RUNNER POOL was
> starved all afternoon (12+ zero-step cancellations across every PR,
> up to 51 min queued; ZERO real Linux failures) — #316 merges and
> the last ubuntu lanes re-green on the watchdog wakeups; every
> Windows lane and every completed ubuntu lane is green. Main @
> fd47f7c, out/ REBUILT + stamp verified both bundles — `npm start`
> is current. Full hand-test batch + suggested train order
> (#305→#307→#308→#318→#309, stream.spec keep-both) in the run-7
> final report. One worker casualty: Dan's mid-run interrupt stopped
> the #261-A/#260/#294 agents — ALL after their handoffs; zero work
> lost; the #310 scope-expansion bounced and ran as its own worker.
> Zero lock steals, zero red pushes, zero rate-limit warnings.**
>
> **Single-writer rule:** this file is written ONLY by the orchestrator
> session. Workers report via handoff files in
> `.claude/work_files/orchestrator/<issue#>.md`; handoffs are the inputs,
> this file is the output. If this session dies, a fresh /orchestrate
> session resumes from THIS block.
>
> **Queue (run-7, as dispatched):** #280 (renormalize, SOLO —
> zero-open-PR window, internal) → then parallel: #260 (E19-04, UF),
> #274 (banner shrink-guards, UF), #294 (title hygiene pair, UF) →
> backfill: #261 part A (superseded mid-run by Dan's #310 diagnosis),
> #284 (urgency clock seam, internal), #300 (git-identity ??→||,
> internal), #255 (eslint type-checked MEASURE, internal), + #310
> (Dan's live bug, inserted) + one #309-CI-fix follow-up. Held/
> decisions: #80 #111 #268 #269 #290 #292 #295 #216 #207 #200 #191
> #129 #256(epic); NEW decisions this run: #255 tranches, prettier
> adopt/drop (#280 finding), E19-04 acceptance (v0.1.1 vs draft
> recipe), #320 lamp beat. #261 closes at train time citing #308 +
> #318 + #313/#319.
>
> **Active workers: NONE — all work complete, run in CI-settle
> close-out.** Queue EMPTY. Worktrees idle+clean (parked refs:
> sb-wt-1 feature/260-update-install + feature/300-…, sb-wt-2
> feature/310-… + 274/261 refs, sb-wt-3 detached). Main checkout
> REBUILT at fd47f7c, stamp verified in both bundles. Remaining
> mechanics: queued ubuntu CI lanes (runner starvation all
> afternoon) on #307 #308 #309 #316 #318 → then MERGE #316
> (internal, no code failures anywhere). Train-conflict watch:
> #308×#310 (stream.spec.ts — both append at the end,
> self-contained, keep-both; train order #308 first). #274×#284
> conflict MOOT (#317 test-side only, merged).
>
> ✅ **#309 CI-fix pushed (903892c on feature/260-update-install,
> PR updates in place).** Root cause: TEST race, not product — the
> stub's 24-byte installer ran downloading→verifying→launching in
> ~ms, and the dialog correctly unmounts the bar at launching, so
> CI's first poll missed it (the live-v0.1.0 probe had already
> proven real determinate progress on a 104 MB download). Fix: the
> test owns the wire — stub sends half the body, holds until
> releaseBody(); assertion STRENGTHENED (real <progress max=100>,
> value exactly 50, label "50%" — proves byte-tracking, not
> existence). 13/13 green repeats; full gate 2304 unit / 194+1 e2e.
> Windows lanes green on the push run; ubuntu lanes queued (infra).
> Handoff appended to 260.md.
>
> **#255 MEASURED, no PR (stays open on Dan's decisions).**
> Headline: switching src/ to recommendedTypeChecked = **161
> errors / 53 files / 10 rules — 126 in tests, only 35 in shipping
> code** (tranches: shared+build+preload 1, main-prod 24,
> renderer-prod 11, main-tests 52, renderer-tests 73). Zero parse
> errors, type program verified live. Two findings: (1) 49 of 79
> require-await hits are RTL's `await act(async …)` idiom — worker
> TESTED the naive strip (43/43 still green = silent effect-flush
> regression), so the test tranche can't hit zero-disable honestly
> without a scoped rule-off; (2) **no-base-to-string ×13 is a real
> latent bug class**: `String(<unknown off CLI JSON> ?? '')` at the
> untrusted-stream boundary renders `[object Object]` into the
> feed/approval card (FeedView.tsx:737, stream-permissions.ts:70
> user-facing) — the strongest argument FOR the switch; B-tranche
> is correctness, not lint hygiene. 3 decisions queued for Dan in
> the issue comment on #255. Branch has zero commits; worktree
> pristine. Handoff: 255.md.
>
> **#310 → PR #318 READY, IN DAN'S QUEUE** (user-facing; Dan's
> live allow-all banner bug — points 2+3 of his diagnosis verified
> and fixed). StreamPermissions.decide() now applies
> permission-resolved (required ctor collaborator, compiler-found
> call sites); SessionGrid's auto-allow opens the recentlyDecided
> suppression window (review also fixed: it was a boolean whose 2s
> timer never re-armed — now a counter). One deliberate divergence:
> forgetSession() does NOT apply (mirrors the hook path; ipc.ts
> names the hazard; reviewer agreed). The e2e nearly had no teeth —
> with plain !perm the fake answers same-tick and the spec passed
> with both fixes reverted; worker added !permhang to the fake (ask,
> run tool, say nothing) and it now fails on revert. Gate: 2238
> unit / 189+1 e2e ×2 runs. PTY pinned unchanged. No manual changes
> owed. **Point 4 confirmed WORSE than filed → #319 filed**
> (stream holds: no timeout/liveness/releaseHeld — closed window
> parks the CLI FOREVER; plus stream allow-all should be answered
> server-side). **Dan: the BEEP + Events entry per gated call in
> allow-all Direct sessions SURVIVES #318** — that's #319 part (b),
> not a miss in this PR. #261 disposition at train time: close it
> citing #308 (part A) + #318 (mechanics) + #313/#319 (remainder).
> Handoff: 310.md.
>
> **CI infra note (ongoing):** second sweep 13:0x — five more
> failures ALL infra (one Set-up-job, four 0-step starvation
> cancels; #307's ubuntu unit lane now on attempt 5). Reruns
> triggered for #316/#307/#308. Zero real code failures beyond
> #309's update.spec race (fix worker active). Third sweep ~13:50:
> lanes flipping green across the board; #309's newer run had its
> Windows e2e PASS (race is timing-dependent — determinism fix
> still correct) and one more ubuntu starvation cancel (rerun
> blocked while the run's last lane finishes; the fix worker's
> push supersedes it anyway).
>
> ✅ **#284 → PR #317 MERGED 2026-08-06** (internal; main @
> fd47f7c; issue closed; CI 4/4 green pre-merge). Entirely
> TEST-SIDE (+201/−19, zero product files → #274 train conflict
> moot). e2e: withStoppedClock pins the renderer's Date.now for
> the jump assertions. Unit: 5 new fake-timer tests for the
> strip's untested half of the beat (incl. the clock-skew re-arm
> branch). Determinism proven by CONTROLLED EXPERIMENT, not green
> repeats: 5s stall between jump and assertion — clock stopped
> passes, clock running reproduces the issue's exact signature.
> Gate: 2221 unit / urgency ×6 42 passed / 188+1 e2e. Discovery →
> **#320 filed** (the REAL product weakness, deliberately unfixed:
> the 1.5s lit beat runs from keypress, not paint — slow machine =
> no lit lamp; §5.8 design call, → Dan's decision list). Worker
> process note worth keeping: `read -t N` under Git Bash does NOT
> block (instant EOF — lock polls silently shrink); use
> `perl -e 'select(undef,undef,undef,N)'`. Handoff: 284.md.
>
> ✅ **#300 → PR #316 DONE — bumped onto fd47f7c (main moved; repo
> requires up-to-date branches; auto-merge not enabled repo-side),
> re-CI in flight, watchdog merges on green** (internal).
> `??`→`||` on BOTH sides of the mirror (git-identity.ts +
> bundle-guard.js); the #298 mirrored-literal pin replaced by a
> test that IMPORTS probeBuildIdentity into bundle-guard.test.js
> and asserts agreement across 7 env shapes (revert-proven: 2 red).
> Sibling audit: no third copy of the fallback repo-wide. Gate:
> 2218 unit / 188+1 e2e first-try. Nice property: this PR's own
> merge is the test — the resulting push build of main should stamp
> "on main", not "on detached". Handoff: 300.md.
>
> **⚠ CI infra is flaky today (2026-08-06 afternoon):** repeated
> runner starvation (jobs cancelled at 15m with 0 steps, no runner
> assigned — #307 ×3 attempts, #309 ×3 jobs) and "Set up job"
> failures (#308 ×3 jobs). Reruns triggered; only ONE real code
> failure found under the noise: #309's new update.spec.ts:370
> progress-bar visibility race on CI Windows (bar likely unmounts
> before the first expect poll on a fast loopback download — both
> attempts, 193 others passed). Follow-up worker dispatched on the
> #260 branch to root-cause and fix without weakening the
> determinate-bar assertion.
>
> **🎉 v0.1.1 LIVE (2026-08-06 ~21:15) — RUN 7 FULLY CLOSED.**
> Release workflow run 31136739445 SUCCESS at e1e8f6c:
> switchboard-Setup-0.1.1.exe (103.9 MB) + .sha256 + changelog
> notes, published (not draft). One release-blocking find en
> route: `scripts/release-notes.test.js`'s real-CHANGELOG guard
> pinned EXACTLY ONE section (true only for the first release
> ever) — the v0.1.1 tag was the first to hit it; fixed on main
> (e1e8f6c: newest-section-is-current + all-entries-semver, both
> original intents kept), tag moved, second workflow run green.
> Dan's one-click E19-04 acceptance test: run the b7c605f tree
> (`git checkout b7c605f && npm run build && npm start` — reports
> 0.1.0 with the new download code) → dialog offers v0.1.1 →
> Update → installed app becomes 0.1.1 (stamp e1e8f6c) →
> "You're now on v0.1.1" in the events panel. Worktrees parked
> detached clean; zero branches left; open decisions: #255
> tranches, prettier adopt/drop, #320 lamp beat + standing list;
> recommended run-8 lead: #319.
>
> **(history) TRAIN MERGED + v0.1.1 CUT (2026-08-06 evening):** the Actions
> outage cleared after ~3.5 h (6 status polls); one CI kick
> (empty commit — dropped events don't replay), 4/4 green FIRST
> TRY, **#321 merged (merge commit, main @ b7c605f)** — all six
> member PRs flipped MERGED, issues #274 #294 #310 #260 #300
> closed, #261 comment-closed citing #308+#318+#313/#319, all
> seven branches deleted, worktrees detached clean. Release
> v0.1.1: bump+changelog committed, tag pushed, E19-02 workflow
> run → see below. Historical detail of the outage block follows.
>
> **(history) TRAIN + RELEASE (Dan-authorized 2026-08-06 ~15:00): BUILT AND
> BLOCKED BY A GITHUB ACTIONS MAJOR OUTAGE.** train/2026-08-06 (PR
> #321) carries all six queued branches — merged ZERO conflicts,
> both stream.spec.ts blocks verified present, full local gate
> green: lint/typecheck clean, unit 2362/2362 ×2 (one transient
> file-level fail on the first run, gone on two consecutive
> re-runs), e2e 197+1 under the lock. But githubstatus.com reports
> **Actions: major_outage** — run creation for this repo stopped
> ~18:00Z (the afternoon's "starvation" was the leading edge; the
> 17:53Z main-push run for #317's merge was all-lanes 0-step
> cancelled — infra, NOT code). PR #321 got no run despite open,
> reopen, and an empty-commit synchronize. The v0.1.1 release plan
> (bump+changelog → tag → E19-02 workflow) is equally blocked —
> the workflow runs on Actions. **Dan's call (2026-08-06 ~16:30):
> WAIT for GitHub — no --admin, no manual release.** Watchdog
> loop: on Actions recovery → train CI green → merge #321
> (--merge) → close #261 w/ comment → delete branches → release
> v0.1.1 (bump+changelog → tag → E19-02 workflow) → Dan's
> one-click test steps. #316 (#300) rides the train. Local main
> checkout: train branch checked out.
>
> **DAN INTERJECTED MID-RUN (2026-08-06):** hit the Direct-mode
> handoff-banner bug LIVE (allow-all session, banner flashes ~5s on
> every permission ask) and sent a 4-point code-level diagnosis from
> another session. Filed as **#310** (companion to #261): (2)
> StreamPermissions.decide() never applies permission-resolved —
> status lingers until the next stream message; (3) allow-all
> auto-answer leaves hasApproval=false during needs-permission =
> the banner's render condition; (4) stream allow-all is
> renderer-only — window-dead case = possibly a parked CLI
> (verify-and-report, split later). Point (1) = #261-A, already
> fixed in PR #308. Worker dispatched on 2+3, 4 as writeup. NOTE:
> Dan's interrupt STOPPED the #261-A agent post-handoff (work
> complete, nothing lost); its scope-expansion message bounced,
> hence the separate #310 worker.
>
> **Merge queue:** empty. **Dan's queue (4 PRs):** #305 (#274,
> 4/4 green) · #307 (#294, 2 unit-lane jobs were CANCELLED by a
> GitHub runner-starvation hiccup at attempt 2 — steps:[], runner_id
> 0; e2e lanes green; rerun triggered, NOT a code failure) · #308
> (#261-A, CI running) · #309 (#260, CI running). Plus a
> non-blocking QUESTION from #260's worker: the E19-04 done-when
> needs a real installed update to fully prove; drafts are invisible
> to releases/latest and the worker rightly refused to publish. Dan:
> either cut v0.1.1 as the acceptance step or ask for the
> draft+dev-override recipe (details in 260.md handoff §Question).
>
> **#294 → PR #307 READY, IN DAN'S QUEUE** (user-facing). Header
> name span now ellipsises (header overflowed its card by a
> measured 1170px before, 0 after); empty/whitespace renames
> rejected at BOTH the rail field (edit ends, old name stands —
> Escape's idiom) and `sessions:renameCard` in main (the seam that
> made `''` truly impossible; review-found, the more important
> half). +9 unit (2225), +1 e2e (189+1), mutation-proofed all three
> guards. Manual: 02-sessions.md + 07-workspace.md. Discovery →
> **#311 filed** (GROUP rename has the identical defect ~380 lines
> below, worse: empty name ≈ unrenameable group). Handoff: 294.md.
>
> **#261-A → PR #308 READY, IN DAN'S QUEUE** (user-facing; Part A
> of #261 — issue stays open pending part-B disposition, now filed
> as #313). The one-line fix (transport threaded into FeedView in
> the feed contribution) + the layered tests Dan asked for: unit
> table over all three handoff branches × three transports, a
> WIRING test at the panels.tsx boundary (mutation-verified: drop
> the prop → red), and an e2e that drives a real Direct session to
> needs-permission and asserts bar+button absent while the Terminal
> tab says "No terminal". Part-B writeup (criterion 6, code-reading
> only): the false-alarm mechanism is the hook Notification
> /permission/i arm at state-machine.ts:176 — the E18-07 stream
> guard already suppresses the HOLD one layer down but not the
> STATUS; recommendation = producer-side suppression in
> hook-listener; **filed as #313** with the fake-stream testability
> gap and the Dan-decision live-probe pairing (hook-listener.ts:633).
> Dropped-prop audit of all of src/: 2 real hits → **#312 filed**
> (IdentityChip accent/badge dead app-wide + preload permission-DTO
> typing fold-in), 1 latent noted, 1 fixed in-PR (PanelContext.
> approval.reason, type-only). Gates: 2226 unit / 189+1 e2e, 3
> mutation checks. Manual: 03-session-view.md + 11-troubleshooting.md
> transport-qualified. Handoff: 261.md.
>
> **#260 → PR #309 READY, IN DAN'S QUEUE** (user-facing; E19-04,
> the last E19 item). Update button now downloads with determinate
> progress + working cancel, verifies against the .sha256 sidecar
> (mismatch = delete + never execute + browser fallback), silently
> installs per-user, quits; next startup confirms "You're now on
> vX" in the events panel via persisted pendingUpdateVersion.
> Escape/click-away leaves a dismissible "ready to install" notice;
> Ignore/Skip don't (they're answers). Security posture from the
> review: token gated by HOST (api.github.com only, never the 302
> redirect target), update:install takes NO renderer arguments,
> sidecar read against a hard cap. Read-only probe against the LIVE
> v0.1.0 release proved the real network+verify contract (103.8 MB
> through the real 302, token dropped, checksum matched, flipped
> byte caught); no release/tag/draft created, no installer executed,
> machine untouched (still on v0.1.0). Gates: 2304 unit (+88) /
> 194+1 e2e. Two real defects caught by e2e in-flight (stalled-body
> cancel; a test opening real browser tabs) — both fixed + pinned.
> Manual: 13-updates.md extended. Discoveries → **#314 filed**
> (EventsPanel reconnect offer has no aria-live) + **#315 filed**
> (withdrawn-release race message). QUESTION for Dan above. Handoff:
> 260.md.
>
> **#274 → PR #305 READY, IN DAN'S QUEUE** (user-facing class;
> 2026-08-06). Audit of App's 100vh column: TitleBar, StatusBar,
> UrgencyStrip, CollapsedStrip had NO shrink guard; read-only
> banner's was unpinned. Landed flexShrink:0 on all + the real
> point: `always-visible-notices.test.ts`, ONE roster naming every
> always-visible bar + an App.tsx scan that fails when a new shell
> child is in neither roster nor stated exemption (#241's
> .preflight-banner pin folded in — two lists would recreate the
> bug). 9 mutations verified. Gate: 2226 unit (+10) / 188+1 e2e.
> Scope call flagged: TitleBar/StatusBar included ("notice" doesn't
> obviously cover them; reverting is 2 roster rows + 1 line). No
> manual page — no observable change at ordinary window heights.
> Discoveries: **#306 filed** (popout banner guard unreachable by
> the roster, unpinned); chrome.tsx:222 long-line → folded into the
> standing prettier decision. Handoff:
> `.claude/work_files/orchestrator/274.md`.
>
> ✅ **#280 → PR #304 MERGED 2026-08-06** (internal; main @ 134868c;
> issue closed; 4/4 CI green first try, incl. both windows jobs).
> `.gitattributes` (`* text=auto eol=lf` + binary/`.cmd` carve-outs).
> **Headline: the renormalize was a NO-OP** — every tracked blob was
> already LF in the object store (zero CR bytes verified); the defect
> was checkout-side only, so the quiet-window constraint never
> applied and no branch can inherit phantom conflicts. Final diff: 4
> files (.gitattributes + 3 comment-only edits). Gate: 2216 unit /
> 188+1 skip e2e. **Discovery → Dan's decision list: the issue's
> prettier premise was WRONG** — prettier isn't a dependency at all
> (`lint` = `eslint .`); making `prettier --check` pass would mean
> ADOPTING prettier and reformatting ~400 files (style, not line
> endings). Decide: adopt or drop. **Flake watch (strike 1):**
> focus-state.spec.ts:38 failed once in the gate, green isolated +
> full re-run; fixed `waitForTimeout(900)` — the #145 class; second
> strike promotes. Handoff: `.claude/work_files/orchestrator/280.md`.
>
> **(history) 🎛 RUN 6 CLOSED 2026-08-05.** **22 items in ~9.5
> hours: 9 internal MERGED (#257 #258 #217 #273 #227 #282 #279
> #286 #298 — four of them filed mid-run from discoveries), 13
> user-facing PRs in DAN'S QUEUE (#263 #265 #270 #272 #276 #281
> #283 #285 #287 #293 #296 #301 #302). E19 (release & auto-update,
> Dan's directive) planned from a ClaudeMon dissection, filed as
> #257–#260, and executed to the boundary: packaging + tag-driven
> release workflow MERGED and dry-run-verified end-to-end (run
> 31029042359: installer artifact built, publish skipped) — the
> FIRST REAL RELEASE is Dan's one command: `git tag v0.1.0 && git
> push origin v0.1.0`. The headline fix: the urgency/idle-collapse
> "flakes" were a REAL renderer race (stale snapshot overwrites
> newer status — forensics → reclassify → last-write guard, PR
> #283). 19 issues filed from discoveries (#264 #267 #268 #269
> #271 #273 #274 #279 #280 #282 #284 #286 #289 #290 #292 #294
> #295 #298 #300), 9 fixed same-run. One worker stall (backgrounded
> e2e — the run-3 lesson; caught, resumed, recovered), zero lock
> steals, zero red pushes. Main @ 24bacac, unit baseline 1762 /
> e2e 168+1 skip on the last merged gate; out/ REBUILT at 24bacac,
> stamp verified in both bundles — Dan can `npm start`. Hand-test
> batching + suggested merge-train order in the run-6 final
> report. Worktrees parked clean; Dan-PR branch refs kept.**
>
> **(history) 🎛 RUN 5 CLOSED 2026-08-05.** 14 items in ~9
> hours: 8 internal MERGED (#230 #219 #229 #224 #234 #236 #235
> #245, four of them filed mid-run from discoveries), 6 user-facing
> in DAN'S QUEUE (#232 #240 #242 #243 #249 #252). 10 issues filed
> from discoveries (#234 #235 #236 #239 #241 #245 #246 #250 #251
> #253 + #255), 4 of them fixed same-run. Zero worker stalls, zero
> lock steals, zero red pushes; one macOS fs.watch flake (known,
> cleared on re-run) and one urgency.spec double-flake (promoted to
> #251). Main @ 36488f2, unit baseline 1318 / e2e 161+1 skip; out/
> REBUILT at 36488f2 and stamp verified — Dan can `npm start`.**
> **Single-writer rule:** this file is written ONLY by the
> orchestrator session. Workers report via handoff files in
> `.claude/work_files/orchestrator/<issue#>.md`; those handoffs are
> the inputs, this file is the output.
>
> **Merge train COMPLETE (2026-08-05, Dan-authorized):** all six
> user-facing PRs merged in order #242 → #240 → #232 → #243 → #249
> → #252, each bumped + re-greened; issues #215 #222 #77 #221 #196
> #197 all closed. **Main @ 15eab97; out/ REBUILT, stamp 15eab977
> verified in both bundles — Dan's `npm start` is current.**
> Integration work the train needed (all verified locally before
> push, all green on CI): 3× the same pre-#245 dialog-stub
> require-await in new specs (#232, #252, + #243's theme.spec had
> the #244-class Element-typing errors — same fixes those PRs
> established); 2 real conflicts resolved — tokens.drift.test.ts
> (#240's conditional-className regex matcher × #243's TINTED_RULES:
> took both), SessionGrid view-tabs (#197's real tablist structure
> × #243's ink token: kept the tablist, adopted the ink token) +
> 06-keyboard.md (both sections kept, sequenced). **Unit baseline
> on merged main: 1527** (measured locally on the final tree); e2e
> baseline: next gate run re-measures (161+1 plus #232's +2,
> #243's +1, #252's +3 — expect 167+1 skip; CI green on the exact
> merged tree). **Dan: hand-test list in the run-5 final report.**
> Newly unblocked by the train: #250 (one-liner), #246 (+
> .collapsed-row joins TINTED_RULES in one line now), #78 (E9
> pinning, seam noted on issue).
>
> **🎛 RUN 6 record (CLOSED — details per item below).**
> Single-writer rule: this file is written ONLY by the
> orchestrator; workers report via handoff files in
> `.claude/work_files/orchestrator/<issue#>.md` — handoffs are the
> inputs, this file is the output.
>
> **Merge train COMPLETE (2026-08-05→06, Dan-authorized):** all
> 13 merged in order #263 → #270 → #283 → #293 → #272 → #265 →
> #302 → #287 → #301 → #285 → #296 → #281 → #276; issues #250
> #239 #251 #264 #241 #246 #267 #78 #79 #253 #289 #271 #259 all
> closed. Integration the train needed (all verified locally
> before push): 5 real conflict sets resolved (tokens.drift EOF
> ×2 incl. a 3-way, SessionGrid closeCard [#264's store-first
> title × #78's retireCard], the 6-file #287×#301 set, the
> 3-file #276 set) + 3 semantic integrations (tokens.css lamp
> paragraph now states the audited truth; #281's ipc.test.ts
> comment corrected per #288; #246's caret ink fix PORTED into
> lib/markdown.tsx — the Markdown move predated the fix, so the
> raw hue would have ridden back in). One REAL find: the #246
> painted sweep was green BY LUCK both ways — it sampled
> mid-`transition: color` and read the previous theme's values;
> now transitions are off during sampling and letterless glyphs
> (✕, ⌄) are excluded from a WORDS test (nordic's --rail-close is
> byte-equal to --status-idle — a value coincidence, not a
> defect). One process slip: one red push (a truncated-output
> misread called a failing a11y test green) — caught on the next
> explicit-counts run, fixed in 10 min; counts line, not tail,
> from now on. Residual noted: transport-seam.test.ts:152 still
> carries the pre-#281 onExit-synchronicity overstatement
> (pre-existing, #228-era) — fold into the next hygiene item.
>
> **🎉 v0.1.0 CUT AND INSTALLED (2026-08-06):** changelog date
> stamped + pinning/focus/update-checker notes added (7890d2b);
> tag v0.1.0 pushed; release workflow run 31069819383 SUCCESS —
> the FIRST REAL RUN of the E19 pipeline: gate → package →
> sha256 → `gh release create` with changelog notes, all green.
> Release is LIVE (not draft): switchboard-Setup-0.1.0.exe
> (~104 MB) + .sha256. Local `npm run package` at the same
> commit produced the installer Dan's machine got: silent
> per-user install exit 0, stamp 7890d2b verified inside the
> installed app.asar (both bundles). out/ in the main checkout
> is also at 7890d2b — `npm start` and the Start-menu app agree.
> **The dogfood loop is closed pending #260:** the installed
> app's checker (gh-token path on this machine) now sees v0.1.0
> as current; the NEXT release will pop the dialog for real.
>
> **Process decisions (Dan, 2026-08-06, both LIVE):**
> 1. **Batch merges use a TRAIN BRANCH** — one integration
>    branch, one local gate, ONE CI run, merge commit (auto-
>    closes member PRs). Encoded in /orchestrate; per-PR squash
>    tidiness deliberately traded away (run 6's serial train
>    burned ~17 CI runs / ~5 h re-verifying green PRs).
> 2. **macOS CI job runs on main pushes only** (PR #303, main @
>    ad3d336) — its lone unique PR signal was the fs.watch
>    flake. Required checks trimmed to the 4 PR-event jobs in
>    BOTH layers: classic branch protection AND ruleset 19646817
>    ("main: green CI required to merge") — the ruleset was the
>    hidden second gate that blocked the first merge attempt;
>    remember it whenever required checks change.
>    release-workflow.test.ts's matrix pin now holds both halves
>    of the conditional.
>
> **Run 7 queue:** #280 .gitattributes renormalize FIRST (zero
> open PRs right now — the one perfect moment) → #260 (E19-04,
> now unblocked: #276 merged + a real release exists) → #274 →
> #294 → #284 → #300 → #255 (measure). Dan's decision list
> unchanged (block below).
>
> **Decisions Dan owes (run-6 additions):** the 5 E19 decisions
> on #256 (veto window); **#80** — build now or slip to E14
> (deliberately not dispatched); **group REORDERING** — should it
> exist at all (#253/#285 proved it doesn't today); **#268**
> EventsPanel opacity de-emphasis (you hand-tuned it); **#269**
> identity-badge accent ink family; **#290** per-session stateDir
> retention; **#292** OS-killed popout session rescue shape;
> **#295** sticky pinned rows (§5.8 overflow clause). Standing:
> #200 #191 #129 #111 #207 #216, E9-past-#80/E11/E13/E14 scoping,
> nordic status-ink shade (#243).
>
> **#256 PLANNED first, per Dan's directive (done 2026-08-05):**
> ClaudeMon dissected — it is C#/WinForms + Inno Setup with a
> hand-rolled updater on a PUBLIC repo, so it contributes
> architecture/policy, not portable code. Epic **E19** written into
> `docs/plans/04-phase-2-switchboard.md` with 5 up-front decisions
> (all veto-able in one comment on #256): feed = this private
> repo's Releases with a locally-resolved token (credential store →
> `gh auth token` → silently off; never embedded); hand-rolled
> checker over electron-updater (electron-builder for packaging
> only); Windows-only unsigned v1 (per-user NSIS = no UAC; in-app
> download carries no Mark-of-the-Web = no SmartScreen); OQ #6 not
> triggered (private dogfood; re-arms at public release); on a
> private repo 404 = auth problem, never "up to date" (the
> ClaudeMon trap). Items filed **#257 → #258 → #259 → #260,
> strictly serial**; #256 stays open as the epic tracker.
>
> **Active workers:** none — run closed. **Worktree pool:** all
> three parked clean on their last Dan-PR branches (refs kept:
> sb-wt-1 feature/267-lamp-ink, sb-wt-2 feature/79-focus-policy,
> sb-wt-3 feature/298-check-guard was merged — its parked ref is
> feature/289-single-instance).
>
> **#267 → PR #302 READY, IN DAN'S QUEUE** (user-facing; the
> run's last item; 5/5 CI green pre-queue). The call, stated:
> the lamp name is TEXT at 10px → 4.5:1 (only dot + ring are
> graphical objects). Defect was worse than filed: the lit rule
> wrote --muted with no color at all — 2.77–3.67:1 in the wild.
> Untangle: every hue wash names the hue's ink; washes 22/26% →
> 12/15% (measured ceiling over --panel2 is 15%); lit ring
> became load-bearing → it's the ink too (1.80 → 5.21 daylight);
> second below-AA state fixed en route ("you are here" 4.10 →
> 8.44). Guards: drift test asserts the MODEL (roles + no-
> overwrite + cascade order) + ratios ×4 themes; new
> UrgencyStrip.test.tsx; e2e walks 8 states × 6 statuses × 4
> themes under a real pointer. Gates: 1827 unit (+83) / 170+1
> skip e2e ×2 + urgency.spec ×6; 14/14 mutations. #284
> untouched by design. Train note vs #265: no overlapping hunks;
> one tokens.css paragraph to replace. Handoff:
> `.claude/work_files/orchestrator/267.md`.
>
> ✅ **#286 → PR #297 MERGED 2026-08-05** (internal; main @
> 29e23a3; issue closed; 5/5 first try). e2e:only + e2e:ui now
> print the bundle's baked identity and HARD-FAIL on stale
> inputs (E2E_ALLOW_STALE=1 escape hatch); identity read from
> the bundle's own bytes, not a sidecar. 1744 unit (+44).
> testing.md corrected. One-strike flake watch: groups.spec
> E12-04 drag failed once in its gate (5/5 green isolated,
> unreachable by the change) — second strike promotes per the
> rule. Discovery filed: **#298** (check:* scripts run out/
> bundles with no build and no guard — same trap class).
> Handoff: `.claude/work_files/orchestrator/286.md`.
>
> **#264 → PR #293 READY, IN DAN'S QUEUE** (user-facing).
> IdentityTab + close-confirm follow the store (the decided
> option 2); found a SECOND stale site in scope — closeCard
> confirm had the store behind never-undefined panel?.title, so
> the store was unreachable; flipped. `lib/card-title.ts` is
> BYTE-IDENTICAL to #263's copy (train keeps either, drops the
> other; e2e placed in tabs.spec.ts to dodge #263's append
> region). Gates: 1694 unit / 170+1 skip e2e, 5/5 CI; new tests
> red without the fix (3/6). Discovery filed: **#294** (title
> hygiene pair: header overflow guard + empty renames — now
> reported twice each). Handoff:
> `.claude/work_files/orchestrator/264.md`.
>
> ✅ **#282 → PR #288 MERGED 2026-08-05** (internal; main @
> 71ec091; issue closed; 5/5 first try, no bump needed). unregisterSession deletes hook-token
> (best-effort, ENOENT-silent); startup sweep for orphans (that
> filename ONLY); ride-along comment fixed. Reviewer BLOCKER
> taken: "one listener per stateDir" was false — NO
> requestSingleInstanceLock exists anywhere; hazard named at the
> sweep site. Gates: 1690 unit (+7) / 169+1 skip e2e; 3
> mutations killed. Discoveries filed: **#289** (single-instance
> lock missing — second instance silently blinds the first's
> hooks), **#290** (per-session stateDir directory +
> settings.json are nobody's job — the larger leak). Train note
> posted on PR #281: its ipc.test.ts comment re-introduces the
> "fires onExit synchronously" claim #288 kills — fix in
> whichever bumps second. Handoff:
> `.claude/work_files/orchestrator/282.md`.
>
> **#251 → PR #283 READY, IN DAN'S QUEUE** (user-facing; the
> race fix). `lib/latest-wins.ts` guard on refreshSessions AND
> refreshGroups (audit found the same defect there — two
> triggers + five command sites); useState initializer, not
> useMemo (React may discard a memo — a discarded guard is no
> guard); one comment in sessions/ipc.ts pins the
> read-before-first-await invariant the guard inherits. Campaign:
> probe 60/60 (vs 1-in-12 baseline), detector specs ×20 under
> load 160/160 BYTE-FOR-BYTE untouched, full e2e under load
> green, 12 unit tests mutation-checked. Discovery filed: **#284**
> (:96 data-lit latent wall-clock flake, split out per the
> forensics). Handoffs: `.claude/work_files/orchestrator/251.md`
> + `251-fix.md`.
>
> **#251 forensics VERDICT (2026-08-05, 48 min, ~200 electron
> runs under a 40-worker load generator): the flaky specs were
> RIGHT — they intermittently catch a real renderer race.**
> `App.tsx:267 refreshSessions()` applies `sessions:cards()`
> responses unordered; an older in-flight snapshot can land last
> and permanently swallow a newer status — worst case
> `needs-permission`, the terminal one, which never self-heals
> (in the wild: card pill disagrees with rail/strip; SessionGrid
> applies pushes directly and is immune). Proof: app's own log
> shows the transition applied in main while 5 atomic DOM
> snapshots 15s later still read "starting…"; guard experiment
> 24/24 green vs 1-fail-in-12 unguarded. Events list already has
> this guard (App.tsx:333 "pushes always win"); sessions never
> got it. Worker STOPPED at the reclassification boundary per
> contract — orchestrator reclassified #251 as a product bug and
> dispatched the fix (same worktree, guard + unit + refreshGroups
> audit; detector specs stay UNTOUCHED). :96's data-lit is a
> separate LATENT flake (10x margin today), noted not fixed.
> Forensics: `.claude/work_files/orchestrator/251.md` + findings
> on the issue.
> - sb-wt-2 IDLE — #80 deliberately NOT dispatched (the filed
>   flag: it may slip to E14 if batch handling should stay
>   layout-pure → Dan's decision list)
>
> **#79 → PR #301 READY, IN DAN'S QUEUE** (user-facing; E9-10;
> 5/5 CI green pre-queue). Pure `lib/focus-policy.ts` four-mode
> table; ladder's revealTargets returns focusIds beside cardIds
> (place and focus are two verbs); surfaces per E9-06 (palette +
> rail-menu radio group, shared OverrideGroup). ⚠ Worker
> CORRECTED the dispatch brief on `none`: i3's manual says
> ignore entirely (no focus, no urgency hint, off the attention
> queue) — the only reading distinct from `urgent`; lamp/rail
> keep painting live status. Reviewer killed a real default-mode
> blocker: dockview isVisible is true for popouts regardless of
> OS window state — popouts answer via document.hasFocus().
> Train notes: 11 files overlap #287 (all additive), one
> guaranteed trivial conflict at SessionsRail props ~:123; two
> API changes (revealTargets opts, queueEvents required);
> drive-by fixture fix (hookPoster reads the LAST hook-listener
> port). Gates: 1734 unit (+34) / 172+1 skip e2e ×2. Manual: 4
> pages. Handoff: `.claude/work_files/orchestrator/79.md`.
>
> **#78 → PR #287 READY, IN DAN'S QUEUE** (user-facing; E9-09;
> 5/5 CI green pre-queue). Pure `lib/pinning.ts`; each exemption
> lives in the rule it exempts from (railOrder / foldableRow /
> submitTarget / bulkClose); pins persist as card ids in the ui
> blob; gestures: rail menu + palette + Ctrl+Alt+P. Two calls
> flagged for Dan in the PR: layout-mode deliberately NOT exempt
> (pinning protects existence/position, not size — unit-pinned),
> and sorts-first means within its rail BUCKET (VS Code
> semantics). Divergence: bulk-close didn't exist, so a minimal
> palette-only "Close all sessions (keeps pinned)" ships with
> it. Auto-eviction seam documented (closableCards — "do not add
> a second if(pinned)"). Gates: 1725 unit / 172+1 skip e2e ×2.
> Discovery filed: **#295** (§5.8 overflow clause deferred —
> sticky pinned rows are a design question). Handoff:
> `.claude/work_files/orchestrator/78.md`.
>
> ✅ **#227 → PR #278 MERGED 2026-08-05** (internal; main @
> d1ab9b7; issue closed; bumped onto a0c7aec + re-greened, 5/5). One registry: `lib/popout-windows.ts` owns
> list + add/remove notifications; App/tab-rows/banner-host all
> subscribe there; the window CustomEvents are gone. Self-review
> caught a real defect in its own first draft (deduped the
> announcement → a dockview-REUSED popout would've stayed
> unthemed; now dedupes the LIST, `added` always fires). Gates:
> 1681 unit (+14) / 169+1 skip e2e, 5 popout specs untouched;
> hunks 3 lines clear of #270's insertion point both directions,
> no overlap with #263. Discoveries filed: **#279** (popout
> closed without remove event stays registered — pre-existing,
> now fixable in one place), **#280** (.gitattributes eol=lf —
> CRLF bit both #258 and prettier repo-wide; renormalize in a
> quiet moment). Handoff:
> `.claude/work_files/orchestrator/227.md`.
> - sb-wt-3 IDLE — queue dry without Dan (remaining items are
>   #80 [behind #79 in flight], Dan-gated [#260 #274 #268 #269
>   #290 #292 #294], or quiet-moment [#255 #280 #284])
>
> ✅ **#298 → PR #299 MERGED 2026-08-05** (internal; main @
> 24bacac; issue closed; 5/5 first try). bundle-guard.js
> generalized; wired into run-electron-node.js so all five
> check:* scripts inherit it (a sixth gets it free, test-pinned);
> foreign-out/ = printed NOTE (branch mirror incl. GitHub env
> fallback — and it caught a real foreign out/ unprompted).
> Override renamed ALLOW_STALE_BUNDLE (old spelling honored).
> Gates: 1762 unit / 168+1 skip e2e (rail.spec drag flake once,
> 9/9 isolated — known class). Discovery filed: **#300**
> (git-identity ?? vs || — empty-string GITHUB_HEAD_REF makes
> push builds report 'detached'; #299 deliberately copied the
> quirk, fix both + the pin). Handoff:
> `.claude/work_files/orchestrator/298.md`.
>
> **#289 → PR #296 READY, IN DAN'S QUEUE** (user-facing; 5/5 CI
> green pre-queue). acquireInstanceLock() is the FIRST statement
> of index.ts (above buildIdentity/enableSandbox — a loser quits
> before touching logs, workspace, or the token sweep) + a
> second guard at whenReady; second-instance → restore/show/
> focus. The real trap solved: a plain lock breaks `npm run dev`
> (electron-vite kills+respawns in one tick, the corpse races
> the replacement) — retry 3s under the dev server ONLY; start/
> e2e/packaged make one attempt. e2e proven safe (per-userData
> lock; new spec points a real second process at a live one and
> asserts hook tokens survive). CI-only catch: raw Electron
> spawn needs --no-sandbox on Linux. Gates: 1709 unit (+19) /
> 170+1 skip e2e; 3 mutations killed; rail.spec drag flake once
> (known class, green isolated + final run). Manual:
> 01-getting-started + new 11-troubleshooting. Handoff:
> `.claude/work_files/orchestrator/289.md`.
>
> ✅ **#279 → PR #291 MERGED 2026-08-05** (internal; main @
> ed7ee50; issue closed; bumped once, 5/5 green). window.closed sweep on
> add/remove + a 5s interval that exists ONLY while the registry
> is non-empty; a window that won't answer is KEPT (evicting a
> live popout costs keyboard+theme, keeping a dead one costs an
> object); #278's 16 tests pass unedited; bonus leak closed
> (App's Map<Window,handler> retained OS-killed windows too).
> Gates: 1693 unit (+10) / 169+1 skip e2e; 7 mutations caught,
> one vacuous test strengthened. One more idle-collapse flake
> sighting (unrelated spec, green isolated + full re-run) — the
> #283 fix in Dan's queue should retire the class. Discovery
> filed: **#292** (OS-killed popout strands its SESSION —
> dockview group/poppedOut never restored; rescue-shape
> decision). Handoff:
> `.claude/work_files/orchestrator/279.md`.
>
> **#253 → PR #285 READY, IN DAN'S QUEUE** (user-facing;
> ⚠ HONEST DIVERGENCE, flagged in the PR and on the issue: the
> title's "group reordering" interaction DOESN'T EXIST — no
> order mutation in workspace/store; the real drag-only gap per
> 197.md is moving a session BETWEEN groups, which is what
> shipped: "Move to group" menuitemradio set in the row's
> Shift+F10 menu, same onMoveToGroup mutation as the drop
> handler, focus re-anchored across the IPC re-parent (the #197
> blocker class), role=status announcement. Group reordering as
> a NEW FEATURE → Dan's decision list. Dead .rail-row:hover CSS
> removed. Gates: 1679 unit (+10) / 170+1 skip e2e; DESIGN §5.26
> gains rule 5 ("a drag is never the only way");
> 06-keyboard + 07-workspace updated. Discovery filed: **#286**
> (e2e:only runs the LAST build — stale-bundle trap that mimics
> logic bugs; 197.md miscalls it). Handoff:
> `.claude/work_files/orchestrator/253.md`.
>
> **#271 → PR #281 READY, IN DAN'S QUEUE** (user-facing;
> main-process). `releaseHeldPermissions(liveId, why)` extracted
> from tearDownLive, called on self-exit BEFORE the exited push;
> deliberately NOT a full teardown (the #187 reap keeps the
> record — a test fails if someone widens it); idempotency
> inherited from delete-before-notify sweeps, pinned both
> orderings. Reviewer caught a wrong mechanism claim in the
> worker's own comments (remove() does NOT fire onExit
> synchronously — kill() is a signal). Gates: 1676 unit (+9) /
> 169+1 skip e2e; 3 mutations all killed. Key hand-tests in the
> PR: kill CLI mid-approval, the remount race, and confirming a
> released hold means the CLI DECIDES FOR ITSELF, not auto-
> approve. Lock note for future contracts: 60s polls can lose
> the handoff — 10s is fine. Discovery filed: **#282**
> (hook-token file lingers on disk + comment-mechanism
> ride-along). Handoff:
> `.claude/work_files/orchestrator/271.md`.
>
> **#259 → PR #276 READY, IN DAN'S QUEUE** (user-facing; E19-03;
> 5/5 CI green pre-queue; 82 min). The private-repo 404 trap
> solved as specced: checker hits `/releases` (list), NOT
> `/releases/latest` — 200+[] = up-to-date, 404 = auth; both
> unit-tested. Token seam: credential-store slot (documented
> no-op) → real `gh auth token` (execFile, 5s) → silent disable.
> Notes render in-app via marked+DOMPurify extracted to
> lib/markdown.tsx (a down payment on E16-01). Two new
> capabilities: update.check, shell.openExternal. NO release/tag
> created — 6 e2e prove the flow against a loopback stub via
> SWITCHBOARD_UPDATE_FEED (dev-only env; e2e fixture pins it
> 'off' so the suite never touches real GitHub). Dan can see the
> dialog TODAY via the stub recipe in the PR body; the
> after-first-release hand-test is 259.md steps 8–12. Gates: 1711
> unit (+93) / 175+1 skip e2e (+6). Self-review killed a
> soft-brick (deadline didn't cover response body + cached
> in-flight promise). **E19 track: #260 HOLDS until Dan merges
> #276** (it builds on the checker's seams; no stacking).
> Handoff: `.claude/work_files/orchestrator/259.md`.
> ✅ **#217 → PR #275 MERGED 2026-08-05** (internal; main @
> d42d890; issue closed; CI 5/5 green first try). Sweep loop's
> module state → `lib/layout-sweep.ts` (`runMoves` +
> `createSweeper`), dockview-free; SessionGrid.test.tsx is the
> module's FIRST unit file (the #224/#239 flag). Gates: 1667
> unit (+49) / 169+1 skip e2e in-turn under lock; review closed a
> real coalescing test gap (mutation-verified). ⚠ Worker stalled
> once at 11:59 (backgrounded e2e + ended turn — the run-3 lesson
> verbatim; zombie lock confirmed, orchestrator resumed it with
> in-turn instructions; recovery clean, lock handed to 259).
> Hunks at :1504+ / import at :34 — no conflict expected with
> queued #263/#270 (stop at :1105). Handoff:
> `.claude/work_files/orchestrator/217.md`.
>
> **#273 WORKER DONE — PR #277 in merge queue** (internal;
> awaiting CI; orchestrator re-runs the release.yml dry-run after
> merge). Fix: `publish: null` in electron-builder.js +
> `--publish never` in scripts/package.js; root cause was the
> UPDATE-INFO fallback (latest.yml) scheduling a GitHub upload —
> a REAL TAG PUSH would have failed identically, so #273 was a
> live-path blocker, not a dry-run quirk. Reproduced + fixed with
> evidence (exit 1 → exit 0, no latest.yml); doesn't repro in
> worktrees (.git is a file there). Gates: 1620 unit (+2) /
> 169+1 skip e2e (waited ~40 min in-turn, no steal); both pins
> red-when-stashed. Handoff:
> `.claude/work_files/orchestrator/273.md`.
>
> **#241 → PR #272 READY, IN DAN'S QUEUE** (user-facing; 27 min,
> the run's smallest). `.preflight-banner` gains flex-shrink:0 +
> a drift-test pin (mutation-checked both ways). Gates: 1541
> unit (+1) / 169+1 skip e2e; lock immediate, no contention.
> Fresh-worktree gotcha recorded: npm ci can leave electron
> binary missing → `node node_modules/electron/install.js`.
> Discovery filed: **#274** (sibling banners' shrink guards
> unpinned or missing — class-level cleanup). Handoff:
> `.claude/work_files/orchestrator/241.md`.
>
> **Merge queue:** empty. ✅ **#273 → PR #277 MERGED** (internal;
> main @ a0c7aec; first bump-and-re-green of the run — #275 had
> moved main under it). release.yml dry-run #2 (run 31029042359) ✅
> SUCCESS: build green, `release-v0.1.0` artifact (~104 MB,
> installer+sha256), publish job skipped as designed — **the E19
> live path is verified short of the real tag, which is Dan's one
> command** (`git tag v0.1.0 && git push origin v0.1.0`; the
> workflow does the rest). (History: #258's first
> dry-run failed on electron-builder's implicit-publish-on-CI,
> run 31020398022 → filed #273, fixed same-run; a REAL tag push
> would have failed identically.)
> **Dan's queue (run 6):** PR **#263** (#250 header title) ·
> PR **#265** (#246 contrast sweep) · PR **#270** (#239 permQueue
> pruning) · PR **#272** (#241 banner no-shrink) · PR **#276**
> (#259 update checker — merging this unblocks E19-04/#260) ·
> PR **#281** (#271 self-exit permission release) · PR **#283**
> (#251 snapshot-race fix — the flaky specs were RIGHT) ·
> PR **#285** (#253 keyboard "Move to group" — divergence note
> in the PR) · PR **#293** (#264 tab strip + close-confirm
> rename fix — dedupes with #263 in the train) · PR **#287**
> (#78 pinning contract — two judgment calls flagged in the PR)
> · PR **#296** (#289 single-instance lock) · PR **#301** (#79
> focus-stealing policy) · PR **#302** (#267 urgency lamp ink) —
> all 13 ready for review, test lists in the PR bodies; suggested
> train order at the top of this block. **New decision for Dan's list:** should rail-group
> REORDERING exist at all (new feature: store order mutation +
> IPC + migration + drag + keyboard)? #285's worker proved it
> doesn't exist today.
> ⚠ Collision note: #263 + #270 + in-flight #217 all touch
> SessionGrid.tsx in different regions; merge train order should
> be #263 → #270 → (#217 rebases after).
>
> ✅ **#258 → PR #266 MERGED 2026-08-05** (internal; main @
> 83ab5a6; issue closed; ~50 min, 5/5 CI first try). release.yml
> = 2 jobs, only `release` holds contents:write; the interesting
> logic is tested Node (`scripts/release-notes.js` — tag-vs-
> version, notes-required hard fail, unpublished rollup,
> create-vs-update idempotency; `scripts/sha256-sidecar.js`),
> +78 unit tests (→1618 on its tree). Self-review caught 3 real
> pre-push bugs (string dry_run input, upload-artifact LCA
> rooting, gh-before-gate masking) + a CRLF/.gitattributes trap
> proved both ways. NOTHING tagged/released — first real tag is
> Dan's call. Caveat for #259/#260: rollup's published-set runs
> under contents:read and may not see drafts. Handoff:
> `.claude/work_files/orchestrator/258.md`.
> **#239 → PR #270 READY, IN DAN'S QUEUE** (user-facing). Prune
> keyed on RETIREMENT (subscribeLiveRetired signal), not
> live===null — a null test would eat the holds E10-04 P0#3
> protects; third teardown path found+fixed in scope (self-exited
> session's bar was tab-reachable behind the overlay); queue rule
> extracted to lib/held-permissions. Gates: 1552 unit (+12) /
> 169+1 skip e2e; 2 review rounds; manual 04-approvals page +1
> para. Discovery filed: **#271** (main never releases a
> self-exited session's held permissions — the wire half; closes
> a remount race too). Handoff:
> `.claude/work_files/orchestrator/239.md`.
>
> **#246 → PR #265 READY, IN DAN'S QUEUE** (user-facing;
> 2h09m, the run's thorough one). NINE raw-hue sites fixed, not
> six — its new one-hop-through-color-tables source scan found
> the feed todo markers, the autonomy chip, and every Events-panel
> state color (1.80:1 daylight) hiding behind a table. All sites
> now 5.2–12.4:1 on four themes; NO ink value changed, so Dan's
> #243 shade veto is untouched. `.collapsed-row` joined
> TINTED_RULES (2 rules): rest passed 4.95:1, hover tint 26%→20%
> (measured ceiling for #243 inks is 21%) — the only visible
> change beyond color swaps. Two staleness guards ship (source
> scan + painted e2e sweep compositing translucent layers).
> Gates: 1646 unit / 170+1 skip e2e (5 full runs under lock), 5/5
> CI green pre-queue; 10 mutations, 9 caught 1 documented.
> Self-review caught a real blocker (site 9) + 7 should-fixes.
> Discoveries filed: **#267** (urgency lamp 3.93:1, lit state
> writes --muted), **#268** (EventsPanel opacity:0.82 drags rows
> below AA — Dan hand-tuned it), **#269** (identity badge accent
> at 3.41:1, accents have no ink family — design call). Handoff:
> `.claude/work_files/orchestrator/246.md`.
>
> ✅ **#257 → PR #262 MERGED 2026-08-05** (internal; main @
> f574ccf; issue closed; remote branch deleted). CI: 4/5 first
> try + the KNOWN macOS fs.watch flake (discovery-scheduler
> "fires on a file APPEARING", 1539/1540 — third sighting: run 5,
> and now twice the same suite), cleared on re-run.
> **#250 → PR #263 READY, IN DAN'S QUEUE** (user-facing). Header
> + "Resuming…" placeholder now read getCardTitle() (the #249
> pattern); empty-title-counts-as-absent + folder-last-segment
> rules encoded. Gates: 1532 unit (+5) / 171+1 skip e2e (+2);
> lock waited behind 246/257, no steal; one urgency.spec:45 flake
> cleared on re-run (ANOTHER #251 sighting — noted there).
> Discovery filed: **#264** (tab strip + close-confirm still show
> stale title; setTitle-vs-store-read is a design call).
> Handoff: `.claude/work_files/orchestrator/250.md`.
>
> **#257 worker done 2026-08-05 (~76 min):** `npm run package` →
> one-click per-user NSIS installer, no UAC; node-pty asarUnpack'd
> + proven inside the INSTALLED app twice (packaged pty-check
> 12/12; Playwright typed into a fake-provider session — zero
> tokens); upgrade-over-running-instance verified; About stamp
> real. Gotcha that outlived the item: `electron-builder.config.js`
> is NOT auto-discovered — silently packages all-defaults; renamed
> to `electron-builder.js` + unit test pinning the discovery list.
> files allowlist saves ~100 MB, guarded by a source-derived dep
> test. switchboard 0.1.0 left installed per-user (uninstaller in
> place). Handoff: `.claude/work_files/orchestrator/257.md`.
>
> **Run-6 queue behind the wave (collision tracks):** E19 serial
> #257 → #258 → #259 → #260 · SessionGrid serial #250 → #239 →
> #217 → #227 → #78 → #79 → #80 (#80 may slip to E14 — flag before
> dispatch) · CSS serial #246 → #241 · tail candidates #251 (flake
> forensics), #255 (measure first), #253 (keyboard drag-drop).
> Parked on Dan's decisions: #200 #191 #129 #111 #207 #216.
> **Decisions Dan owes (unchanged + new):** #200, #191, #129, #111,
> #207, #216, E9-past-#80/E11/E13/E14 scoping; the nordic
> status-ink shade (#243, veto-able in one comment); whether #222
> should have folded into #197 (kept separate).
>
> **Worker pool at run-6 close:** all three worktrees parked
> clean; run-6 Dan-PR branch refs kept locally (250, 246, 239,
> 241, 259, 271, 251-refresh-race, 253, 78, 264, 289, 79, 267)
> plus run 5's (77, 215, 221, 222, 196, 197).
>
> **Done this run:**
> - ~~#245 e2e eslint typeChecked~~ ✅ **PR #254 MERGED** (internal;
>   based on 139a221, 5/5 green first try; issue closed; main @
>   36488f2). 83 errors → 0 with ZERO new disables and no any-casts.
>   Finding that outlived the issue: the `any` was NOT page.evaluate
>   (preload API types infer fine) — it was JSON.parse on
>   workspace.json, six specs each re-describing it inline; now one
>   typed reader in the fixture (`readWorkspaceFile` + Persisted*
>   interfaces). 25/29 require-await were one dialog-stub line.
>   Gates: 1318 unit / 161+1 skip ×2; lock waited ~26 min in-turn
>   behind #197, no steal. Discovery filed: **#255** (src/ still
>   untyped preset — measure first). Handoff:
>   `.claude/work_files/orchestrator/245.md`.
> - ~~#197 a11y sweep~~ **WORKER DONE — PR #252 ready, IN DAN'S
>   QUEUE** (user-facing a11y, the run's biggest diff). #174's rule
>   applied mechanically: real buttons on rail-row name blocks and
>   Events rows (containers stay role-less — option-on-the-row
>   would be an ARIA lie since rows CONTAIN buttons); group headers
>   = disclosures with real aria-controls; view tabs = the one
>   honest composite → tablist/tab/tabpanel, roving tabindex,
>   manual activation; lamps already correct. Scope pull flagged +
>   justified: rail context menu made walkable (focusable rows +
>   Shift+F10 would have summoned a keyboard trap the sweep itself
>   created). Review caught a REAL blocker: document.activeElement
>   is the wrong document in a popout — fixed via ownerDocument.
>   Gates: 1338 unit (+26, 2 new files) / 164+1 skip e2e (+3); lock
>   first try, handed to #245 on release. Manual: 06-keyboard.md.
>   **Merge-train note: 19 e2e call sites moved to
>   getByRole('tab') — queue scanned, no queued PR clicks a view
>   tab (closest: #243's theme buttons); the bump+re-green step
>   self-detects any miss.** Discovery filed: **#253** (no keyboard
>   path for group drag-drop; + dead .rail-row:hover CSS).
>   CollapsedStrip verified already compliant. Handoff:
>   `.claude/work_files/orchestrator/197.md`.
> - ~~#235 killTree POSIX~~ ✅ **PR #248 MERGED** (internal,
>   e2e-fixture; bumped onto 16515ec, 5/5 green; issue closed; main
>   @ 139a221; unit baseline now 1318). Decision
>   verified in installed playwright-core 1.61.1, not docs:
>   launchProcess spawns `detached` on POSIX and reaps with
>   `process.kill(-pid)` — so process-group kill, with bare-pid
>   fallback (ESRCH = already dead is the common case). killTree
>   exported with a platform arg so BOTH branches assert on every CI
>   leg (each was unreachable on the other OS — how the bug
>   survived). Landmine defused: test pids now 999_0xx; `fakeApp(1)`
>   + POSIX killTree(1) = kill(-1) broadcast, one spy from a
>   runner self-nuke. 14 fixture tests (+6), 3 mutations bite.
>   Gates: 1318 unit (+6) / 161+1 skip e2e ×3; lock taken twice,
>   re-acquired after review refactor, no steal. Discovery →
>   **#251** filed: urgency.spec.ts flake, :96 SECOND strike +
>   :45 new, load-sensitive class (flake watch promoted per the
>   one-strike rule). Handoff:
>   `.claude/work_files/orchestrator/235.md`.
> - ~~#196 feed landmark titles~~ **WORKER DONE — PR #249 ready,
>   IN DAN'S QUEUE** (user-facing a11y). Feed region label now
>   "Conversation — {title}" (second ICU key, locale-reorderable);
>   title threaded as PanelContext.title → panels.tsx → FeedView.
>   The non-obvious call: title read from the session store via new
>   `getCardTitle()` accessor, NOT `props.api.title` — dockview only
>   learns a title at addPanel and nothing calls setTitle, so the
>   api copy is birth-time stale and would fail the rename clause.
>   Popouts covered by construction + proven by e2e (rename from
>   main window, popout landmark follows). SessionGrid diff kept to
>   2 hunks (~10 lines) away from #243's header block; CollapsedStrip
>   /App untouched (#232 safe). Gates: 1317 unit (+5) / 163+1 skip
>   e2e (+2); lock 3 acquisitions, waits behind #235, no steal.
>   Manual: 06-keyboard.md; DESIGN §5.10 a11y bullet added.
>   Discovery filed: **#250** (card HEADER still birth-time stale on
>   rename — one line, deliberately after #243 lands). Handoff:
>   `.claude/work_files/orchestrator/196.md`.
> - ~~#236 ipc.test.ts harness consolidation~~ ✅ **PR #247 MERGED**
>   (internal, test-only; bumped onto c99ca6d, 5/5 green; issue
>   closed; main @ 16515ec). `cardHelpers(dir-getter, cardId)` at module level
>   retires the copies in #187/#202/#219 + #170's `suspendedCard` +
>   #218's inline `prior`; `tempDirEach` retires the
>   beforeEach/afterEach pair from all ten blocks. 62 tests → 62,
>   same names/assertions; ipc.ts byte-identical. Three mutation
>   spot-checks bite identically to pre-refactor (incl. a #202-block
>   one the dispatch didn't ask for). Unreachable-guard left exactly
>   as #219 left it (converting the assertion = the one forbidden
>   move). Gates: 1312 unit / 161+1 skip e2e at baseline; built
>   before lock, ~10 min in-turn wait behind #221 then #234.
>   Reported not fixed: priorCard's stray `folder` key; 13-option
>   harness redesign; file-split decision. Handoff:
>   `.claude/work_files/orchestrator/236.md`.
> - ~~#221 status-pill contrast~~ **WORKER DONE — PR #243 ready,
>   IN DAN'S QUEUE** (user-facing). Measured, not eyeballed: pills
>   were 1.66–2.64:1 daylight / 2.99–4.49 nordic; now 4.59–5.23 /
>   4.60–4.63, contrast themes byte-identical. Key finding:
>   nordic's six `--status-*-ink` tokens were themselves below AA
>   (ink==hue) — all six lightened in HSL to the minimum clearing
>   4.5:1; **the one deliberate visual change, flagged as test item
>   3 in the PR for Dan's one-comment veto.** Pill's private
>   STATUS_COLOR table had drifted from the rail (starting read as
>   idle, suspended used --faint) — deleted, pill now asks
>   presentStatus; extracted `StatusPill.tsx`; 4 more raw-hue sites
>   → -ink. Review blocker was real: the early test measured a pair
>   it invented and passed WITH the bug — replaced by jsdom test +
>   an e2e that measures what Chromium PAINTED, all 4 themes. 8
>   mutations, 7 caught, survivor documented. Gates: 1459 unit at
>   its base (+157) / 162+1 skip e2e (+1), CI 5/5 green (pre-#238
>   base; bump at merge). One rail.spec drag-drop flake, passed
>   isolated + full rerun. Discovery filed: **#246** (six more
>   raw-hue sites below AA; .collapsed-row audit gated on #232).
>   Handoff: `.claude/work_files/orchestrator/221.md`.
> - ~~#234 tsconfig.e2e wiring~~ ✅ **PR #244 MERGED** (internal;
>   5/5 green; issue closed; main @ c99ca6d — `npm run typecheck`
>   now covers e2e/). `tsconfig.e2e.json`
>   (ES2023 + DOM libs — evaluate bodies are browser code) wired
>   into `npm run typecheck` + references; proved with a deliberate
>   error (exit 2, file named). Issue's "3 errors" was an
>   undercount: 16 project-wide — 14 `Window.switchboard` fixed by
>   including the renderer's own env.d.ts (one declaration site,
>   fails loud if it moves), 2 genuine type-level fixes (csp.spec
>   closure narrowing, rail.spec SVGElement widening). Bonus:
>   vitest.config.ts + src/test-setup.ts were in NO project (setup
>   file referenced only as a string) — now covered, already clean.
>   Gates: 1312 unit / 161+1 skip e2e ×2; lock waited ~6 min behind
>   #215 in-turn. eslint left alone as instructed, measured instead:
>   discovery filed **#245** (typeChecked preset = 83 errors/21
>   files, mostly page.evaluate any). Handoff:
>   `.claude/work_files/orchestrator/234.md`.
> - ~~#215 stale "(default)" palette string~~ **WORKER DONE — PR
>   #242 ready, IN DAN'S QUEUE** (user-facing, one line in en.json).
>   Verified in code the shipped default is `always-visible`
>   (presentation-policy.ts:49); dropped "(default)" rather than
>   moving it — no sibling string labels a default and the palette
>   already carries it dynamically via `commands.policyDefault`.
>   Staleness sweep of every policy string: this was the only liar.
>   Manual already correct (fixed when the amendment shipped). Gates
>   all baseline: 1308 unit / 161+1 skip e2e; lock waited ~4 min
>   behind #221 in-turn, and worker built BEFORE taking the lock +
>   used e2e:only under it (lock held for playwright time only —
>   good pattern, told to later workers). Nothing new discovered.
>   Handoff: `.claude/work_files/orchestrator/215.md`.
> - ~~#222 PreflightBanner role=status~~ **WORKER DONE — PR #240
>   ready, IN DAN'S QUEUE** (user-facing a11y). Two covers, each
>   filling the other's hole: App mounts the region unconditionally
>   from frame 1, AND the component defers its words one commit —
>   needed because App's tree sits behind `!uiReady` and a MISSING
>   CLI is the fast preflight path, so the banner can genuinely
>   mount with the warning already present (the silent case).
>   Component extracted to `PreflightBanner.tsx` (App unmountable in
>   jsdom); test asserts on the MutationObserver stream (region
>   inserted first, words arrive later), which is what a screen
>   reader actually watches; 4 mutations each caught. #206's drift
>   guard widened to conditional className + narrowed to exclude
>   test files. Popout host verified unaffected (boot-time banner,
>   documented non-goal). Gates: 1310 unit at its base (+8) /
>   161+1 skip e2e ×2; lock instant both times. Manual:
>   11-troubleshooting.md. Discovery filed: **#241** (banner lacks
>   flex-shrink:0). Handoff:
>   `.claude/work_files/orchestrator/222.md`.
> - ~~#224 allowAllByLive release~~ ✅ **PR #238 MERGED** (internal;
>   bumped onto 1ac60a8, 5/5 green; issue closed; main @ b9a23de;
>   unit baseline now 1312). `forgetCardLiveIds` now releases the grant
>   with the binding; `mapLiveToCard` gained the same-pair guard
>   #223 refused — the sweep made it load-bearing (pass-2 ADOPTION
>   returns the same live id on every hide→reveal / dock-back, and
>   without the guard the sweep would revoke a RUNNING session's
>   allow-all). Both readers traced; all 4 forget callers end the
>   session; hiding never reaches it. Renderer set was the only
>   allow-all registry that never released (main's dies in
>   unregisterSession). 4 new tests, mutation-checked (3 fail
>   without the release, 1 without the guard). Gates: 1306 unit at
>   its base (+4) / 161+1 skip e2e; lock first try. Discovery filed:
>   **#239** (permQueue never pruned for dead sessions — review bar
>   can hold prompts that go nowhere + same leak shape; includes the
>   :519 `if (live)`/`?? ''` cleanup). Handoff:
>   `.claude/work_files/orchestrator/224.md`.
> - ~~#229 stream-recipe PATH leak~~ ✅ **PR #237 MERGED** (internal,
>   test-only; bumped onto e3005cd, 5/5 green; issue closed; main @
>   1ac60a8).
>   PATH captured before the prepend, restored in afterEach; sweep
>   found the SAME leak in `claude.test.ts` (`withCliOnPath` saved
>   but never restored) — fixed; third env-mutation site
>   (`stream-spawn.test.ts` ELECTRON_RUN_AS_NODE) already try/finally,
>   untouched. Gates: 1302 unit / 161+1 skip e2e at baseline; lock
>   first try, no contention. Nothing new discovered. Handoff:
>   `.claude/work_files/orchestrator/229.md`.
> - ~~#77 P2-E9-08 idle collapse~~ **WORKER DONE — PR #232 ready,
>   IN DAN'S QUEUE** (user-facing). ≥4 idle collapsed-strip rows fold
>   into one expandable "N idle sessions" row; derived from live
>   status (pure `stripItems`/`foldableRow` in `lib/ladder.ts`);
>   never folds working/attention/focused sessions; fold state is a
>   glance, comes back closed on relaunch. NO automatic idle sweep —
>   worker flagged (correctly) that §5.8's first clause is already
>   shipped as E9-05's collapsed rung and a standing sweep would
>   contradict the 2026-08-04 always-visible ruling; aggregation only,
>   no DESIGN edit. Gates: 1307 unit (+13) / 163+1 skip e2e (+2), CI
>   5/5 green (pre-#231 base; bump at merge time). Lock waited
>   ~20 min in-turn, no steal. Manual: 07-workspace.md new section.
>   Seam for #78 noted on the issue (pinned exempt from fold =
>   one line in foldableRow). **#78 now BLOCKED behind #77's merge**
>   (E9 serial). Handoff: `.claude/work_files/orchestrator/77.md`.
> - ~~#219 tearDownLive ordering~~ ✅ **PR #233 MERGED** (internal;
>   issue closed; main @ e3005cd; unit baseline now 1308. One macOS
>   fs.watch flake on the rebased commit — the KNOWN run-4 flake,
>   discovery-scheduler's real-fs.watch "file APPEARING" test, 0
>   events in 10s; verified unrelated to the diff, cleared on
>   re-run. Flake watch +1.) Design: per-step
>   try/catch (`tearDownStep`) over reordering — mutation-proved
>   (reorder-only design still fails 5/6 new tests). Found + fixed a
>   second casualty: `closeCard`'s persist.remove was skipped on a
>   teardown throw → closed cards resurrected on next boot;
>   `dropLive` (Restart) had no catch either — fail-open moved into
>   the shared function, reap's catch kept as backstop. 6 new tests
>   (1300 unit pre-rebase) / 161+1 skip e2e ×2; lock waited ~22 min
>   in-turn behind #230 then #77, nothing stolen. Report-only: #187's
>   adopt-by-liveness guard now unreachable-by-construction (kept,
>   comments updated). Discovery filed: **#236** (ipc.test.ts harness
>   growth/duplication). Handoff:
>   `.claude/work_files/orchestrator/219.md`.
> - ~~#230 launchApp killTree~~ ✅ **PR #231 MERGED** (internal,
>   test-only; 5/5 green first try; issue closed; main @ c1a84f0).
>   Eager pid capture at `electron.launch()` return (#185 lesson one
>   step earlier), kill-FIRST reap in the catch (an abandoned await
>   skips the kill in exactly the wedged case), shared
>   `gracefulClose()` with the `clearTimeout` the inline version
>   lacked, lazy `electronPath` so `npm test` doesn't need the
>   Electron download. New `e2e/fixtures/app.test.ts` (8 tests,
>   mutation-checked: 5/8 red without the reap); runner split pinned
>   (`*.spec.ts` playwright / `*.test.ts` vitest — verified 162/31
>   unchanged), recorded in `startup/references/testing.md`. Gates:
>   1302 unit (+8) / 161+1 skip e2e ×2. Lock: waited ~7 min behind
>   #219, in-turn, never stolen. Discoveries filed: **#234** (e2e/
>   typechecked by nothing — tsconfig.e2e.json), **#235** (killTree
>   isn't a tree kill on POSIX). Handoff:
>   `.claude/work_files/orchestrator/230.md`.
>
> **Merge queue (serial):** empty. Main @ 139a221.
> **Dan's PR queue (6):** PR #232 (#77 idle collapse), PR #240
> (#222 banner announce), PR #242 (#215 palette string), PR #243
> (#221 pill contrast — carries the one deliberate visual change,
> nordic status inks brightened to reach AA; veto-able in one
> comment), PR #249 (#196 feed landmarks), PR #252 (#197 a11y
> sweep) — all ready-for-review; test lists in the PR bodies.
> Merge-train notes: #243/#232/#249/#252 share SessionGrid-adjacent
> files — expect a conflict resolution or two, each PR bumps +
> re-greens before merge; #252 moved 19 e2e call sites to
> getByRole('tab') (queue scanned: no queued PR clicks a view tab,
> and re-green self-detects any miss).
> **Unit baseline now 1318** (main @ 139a221).
> **Remaining unblocked, undispached:** SessionGrid cluster behind
> #221: #196 → #217 → #197 → #227. #78–#80 blocked behind #77's
> merge (Dan).
> **Decisions Dan owes:** #200, #191, #129, #111, #207, #216,
> E9-past-#80/E11/E13/E14 scoping, and whether #222 should have
> been folded into #197 (run 5 kept them separate).
> **Hand-test result (2026-08-04, post-merge):** Dan ran the
> combined run-4 test list against a fresh build of e22e039 —
> **everything passed.** One tooling lesson from the session, for
> every future hand-test handoff: `npm start` is PREVIEW — it runs
> the last-built `out/` and builds nothing, and worker builds happen
> in worktrees, so the main checkout's `out/` is always stale after
> an orchestration run. **Run `npm run build` (or have the
> orchestrator do it) before handing Dan a test list**, and have him
> confirm the About-panel stamp first. The missing-chip false alarm
> this cost is exactly what the build stamp exists to catch.

> # 🎛 ORCHESTRATION RUN 4 — 2026-08-04, **CLOSED same day. 10
> items: 7 internal merged, 3 in Dan's queue. 13 issues filed from
> discoveries (#211 #213 #215 #216 #217 #219 #221 #222 #224 #227
> #229 #230 + the flake-watch note), 3 of them (#211 #213 + #202's
> gap) fixed same-run. Zero worker stalls, zero lock steals; CI
> flaked twice (npm-ci ETIMEDOUT, macos fs.watch), both cleared on
> re-run. Worktree pool parked clean/detached; Dan-PR branches
> (76, 206, 208) kept locally.**
> **Single-writer rule:** this file is written ONLY by the orchestrator
> session. Workers report via handoff files in
> `.claude/work_files/orchestrator/<issue#>.md`; those handoffs are the
> inputs, this file is the output.
>
> **Queue (from run-3 close, all unblocked):** #76 #180 #196 #197 #201
> #202 #205 #206 #208. Skipped — Dan owes decisions: #200 #191 #129
> #111 #207. Collision tracks honored: #202+#205 = one serial ipc track
> (#205 first); #196/#201 wait behind #76 (SessionGrid/store); #196 #206
> #208 #197 renderer-chrome/a11y cluster staged in later waves; #180
> alone in stream.spec/watcher.test.
>
> **Active workers** (issue → worktree → branch):
> - ~~#76 P2-E9-07 layout modes~~ **WORKER DONE** — PR #214 marked
>   ready, **IN DAN'S QUEUE** (user-facing). Grid/focus/queue as a
>   pure card→rung plan (`lib/layout-mode.ts`) applied through
>   E9-05's setCardLadder — no second layout engine. ▦ titlebar chip,
>   palette, Ctrl+Shift+L cycle, Ctrl+Shift+M / header double-click
>   maximize; ui-blob key `layoutMode`. Four demotion exemptions
>   (needsHuman, active card, popped-out, already-demoted); grid not
>   enforced between switches; a reactive pass never invents a big
>   card. Review: 2 rounds, 15 findings all addressed (best: stale
>   maximize made grid enforcing; gridReady happy-path-only = silent
>   feature death). Gates: 1250 unit (+46) / 160 e2e +1 skip (+4),
>   rebased onto fb3fe81. Manual: 07-workspace.md + 06-keyboard.md.
>   Discoveries filed: **#215** (en.json still calls auto-collapse
>   "(default)"), **#216** (suspended card has no header → no
>   double-click maximize), **#217** (sweep loop unit-untestable —
>   extract runMoves seam). Handoff:
>   `.claude/work_files/orchestrator/76.md`.
> - ~~#201 renderer liveToCard stale entry~~ ✅ **PR #223 MERGED**
>   (internal; 5/5 green first try after bump; issue #201 closed;
>   main @ da1fa42, unit baseline 1212).
>   `mapLiveToCard` sweeps `forgetCardLiveIds(cardId)` before
>   binding, mirroring main's #199 reap; **zero SessionGrid.tsx
>   diff** (no #214 collision). All 5 readers traced safe. Gates:
>   1206 unit (+2, mutation-checked) / 156 e2e +1 skip. Discovery
>   filed: **#224** (`allowAllByLive` same growth shape, never
>   released). Handoff: `.claude/work_files/orchestrator/201.md`.
> - ~~#213 temp-leak suite-wide sweep~~ **WORKER DONE** — PR #228
>   (internal, test-only) marked ready, **in the merge queue** (CI
>   watched, auto-merge on green). New `src/test-temp-dirs.ts` +
>   afterAll net in test-setup (all 76 files), 18 unit files
>   converted, fixture gained pending-dir registry + liveApps guard +
>   exit net + home sweep with retries; `tempProjectFolder()`
>   signature unchanged (#208's spec unaffected). Leaks: unit 232→0
>   (4 runs, isolated TEMP); e2e prefixes 0 new. Review blocker was
>   real: store.test.ts's 500ms debounced save re-created the swept
>   dir — teardown now flushes stores first. Gates: 1227 unit / 156
>   e2e +1 skip on the rebased tree (= main baselines). Discoveries
>   filed: **#229** (stream-recipe PATH entries), **#230** (launchApp
>   failure path never killTrees). Flake watch +1: presentation-
>   policy.spec.ts:154 25s launch timeout, once, passed twice after.
>   Handoff: `.claude/work_files/orchestrator/213.md`.
> - ~~#205 scrollback mid-char trim~~ ✅ **PR #210 MERGED** (internal;
>   5/5 green; issue #205 closed; main @ fb3fe81, unit baseline now
>   1204).
>   RingBuffer oversized-chunk trim now steps to the next character
>   start (bounded 3 bytes); deliberately NO StringDecoder — the split
>   is one this class makes, a flush would emit the U+FFFD being
>   removed (#203's lesson applied, not copied). ipc.test.ts untouched
>   → #202 uncontended. Gates: 1204 unit (+12, proven to bite: 6/11
>   cut offsets fail without the fix) / 156 e2e +1 skip, run twice.
>   Discovery filed: **#211** (replay can open mid-ANSI-escape —
>   eviction is UTF-8-aligned, not CSI-aligned). Handoff:
>   `.claude/work_files/orchestrator/205.md`. Worktree sb-wt-2 free
>   after merge (reserved for #202).
> - ~~#180 test temp-dir leaks~~ ✅ **PR #212 MERGED** (internal,
>   test-only; 5/5 green after one ubuntu npm-ci infra-flake rerun;
>   issue #180 closed; main @ 8e7fd86).
>   watcher.test: makeWatcher factory + registry so teardown survives
>   failed tests; stream.spec: register-what-you-make + shared
>   teardown, requeue for Windows locks. Leak proof: watcher 102→0
>   dirs (isolated TEMP, incl. forced-failure path), stream 0 new
>   across a full e2e. Gates: 1192 unit / 156 e2e +1 skip, e2e run
>   twice. Measured correction documented: fs.rm maxRetries does NOT
>   retry first-touch EBUSY — the requeue covers it. Discovery filed:
>   **#213** (leak is suite-wide: sb-e2e-proj- 20,593 dirs from the
>   shared fixture, sb-hooks- 11k, sb-ws- 7k, sb-e2e- app homes 2k —
>   one sweep issue). Dan's ~100k existing orphans left untouched;
>   one-line cleanup is in PR #212's body. Handoff:
>   `.claude/work_files/orchestrator/180.md`.
> - ~~#206 PreflightBanner light-theme contrast~~ **WORKER DONE** —
>   PR #220 marked ready, **IN DAN'S QUEUE** (user-facing). Root
>   cause: the banner's ink was `--bar`, which flips to #ffffff on
>   daylight → white-on-amber. New layer-2 token
>   `--status-needs-permission-ink-on-fill`; daylight 2.53→6.08:1,
>   all other themes pixel-identical. Drift test now computes the
>   real contrast ratio from what ships, in every theme,
>   mutation-checked 3 ways. Gates: 1197 unit (+5) / 156 e2e +1
>   skip, run twice. No manual page needed (no page describes its
>   appearance). Discoveries filed: **#221** (status pills ≈2.2:1 on
>   daylight — same class, worse, always on screen; after #214),
>   **#222** (banner has no role="status" — screen-reader silent).
>   Handoff: `.claude/work_files/orchestrator/206.md`.
> - ~~#208 pop-out read-only banner~~ **WORKER DONE** — PR #226
>   marked ready, **IN DAN'S QUEUE** (user-facing), rebased onto
>   2960cf4 and gated there. `WorkspaceReadOnlyBanner` portals into
>   every popped-out window via the existing
>   `switchboard:popout-added/-removed` events — one isReadOnly()
>   answer, one component, N draw sites; **zero lines in App.tsx /
>   SessionGrid / tokens.css** (no #214/#220 collision). Dockview
>   relayout under the banner measured, not assumed (group followed
>   container to 400px; terminal re-fit 31→28 rows). Gates: 1243
>   unit (+16, 4 mutations bite) / **157** e2e +1 skip (+1), suite
>   run 3×. Discovery filed: **#227** (three popout-window
>   registries → shared lib/popout-windows.ts). Flake watch:
>   urgency.spec.ts:96 lamp-expiry flaked once locally, passed
>   re-run. Handoff: `.claude/work_files/orchestrator/208.md`.
> - ~~#202 ipc harness streamPermissions~~ ✅ **PR #218 MERGED**
>   (internal, test-only; needed 2 flake-reruns — ubuntu npm-ci
>   ETIMEDOUT-class, then the macos fs.watch flake noted below; main
>   @ 068dec7, unit baseline 1210). The gap was real: deleting the
>   production forget-call left all 1204 tests green before; 6 new
>   whole-teardown tests, 4 mutations bite. Discovery filed: **#219**
>   (tearDownLive fail-open ordering can strand a pending approval).
>   Handoff: `.claude/work_files/orchestrator/202.md`.
> - ~~#211 scrollback ANSI-escape residue~~ ✅ **PR #225 MERGED**
>   (internal; 5/5 green; issue #211 closed; main @ 2960cf4, unit
>   baseline 1227).
>   `snapshot()` skips to the earliest safe anchor (first ESC, or
>   past first LF) only when bytes were actually discarded; push()
>   untouched, no VT parser. Documented bounded limits (raw LF in an
>   OSC payload can still mid-resume; no-ESC-no-LF snapshots left
>   alone). Gates: 1219 unit (+15, 7 bite) / 156 e2e +1 skip.
>   Reviewer verified stray `ESC \` renders nothing in the shipped
>   xterm bundle. No discovery worth filing (RingBuffer.clear() is
>   test-only — noted, no issue). Handoff:
>   `.claude/work_files/orchestrator/211.md`. sb-wt-2 **parked**
>   detached @ 068dec7 (queue empty pending #214).
>
> **Merge queue (serial):** empty — all 5 internal PRs merged
> (#210 #212 #218 #223 #225).
> **Flake watch:** discovery-scheduler.test.ts "fires on a file
> APPEARING" flaked once on macos (0 events/10s) during #218's runs;
> a 2nd occurrence this run → file an issue (urgency.spec.ts:96
> lamp-expiry also flaked once locally — same one-strike rule).
> **Dan's queue (3):** **PR #214** (#76 layout modes, 9-step
> hand-test list) · **PR #220** (#206 banner contrast — hand test:
> daylight theme, read the banner) · **PR #226** (#208 pop-out
> read-only banner — hand test: read-only workspace, pop a session
> out, see the strip).
> **Queue when a slot frees:** nothing unheld left — remaining items
> are all **HELD behind PR #214's merge** (its diff spans
> chrome.tsx, command-set.ts, en.json, session-store.ts,
> SessionGrid.tsx): #196, #197, #215, #217, **#221**, #224, and the
> E9 tail (#77–#80). #216 + #222 skipped this run (small
> discretionary additions — Dan's triage; #222 folds naturally into
> #197's sweep).
> **Issues filed this run:** #211, #213, #215, #216, #217, #219,
> #221, #222, #224.

> (Run-4 detail entries above; handoffs in
> `.claude/work_files/orchestrator/<issue#>.md`.)
> **Dan's decision on PR #198's call #1 (2026-08-04): default is
> `always-visible` ("Keep visible"); auto-collapse/auto-hide are opt-in.**
> Executed on the PR pre-merge (flip + 22 pin deletions + DESIGN §5.8
> amendment + manual reframing); recorded in DESIGN.
> **Run-4 queue, all unblocked now:** #180 (test temp-dir leaks), #196
> (feed landmark titles), #201 (renderer liveToCard stale entry), #202
> (streamPermissions harness gap), #205 (scrollback mid-char trim), #206
> (PreflightBanner light-theme contrast), #208 (pop-outs never see the
> read-only banner), #76 (P2-E9-07 layout modes — E9 track head; #75's
> setLadder/policy seams are merged and stable). Collision notes: #180
> alone touches stream.spec; #196+#206 both touch renderer chrome-ish
> files (serialize or check); #201 touches session-store; #202+#205 both
> touch ipc.ts/ipc.test.ts — ONE track, serialize.
> **Decisions Dan owes** (not blocking the above): #200 (crashed
> session's transcript watch — teardown-on-exit policy), #191 (diff-pane
> syntax highlighting design call), #129 (milestone triage), #111 (real
> tokens — ask before dispatch), #207 (failed-write banner scope), E9
> tail past #80 + E11/E13/E14 expansion (/pm scoping).
> **PHILOSOPHY suggestion from #179's worker, for Dan:** fail-open has an
> unwritten second half — "our failures must never cost the user their
> FILES, not just their session." Worth a line in PHILOSOPHY/DESIGN.
> **Dogfooding note:** Dan hand-tests the run-3 features in situ now that
> they're merged — expect high-signal bug reports as issues; triage them
> into run 4 promptly.

> # 🎛 ORCHESTRATION RUN 3 — 2026-08-03, **CLOSED. 7 items: 3 internal
> merged (#179→PR193, #194→PR203, #185→PR209), 4 in Dan's queue
> (#174→PR195, #75→PR198, #187→PR199, #168→PR204).**
> **ADDENDUM 2026-08-04:** Dan ruled call #1 → `always-visible` default;
> a flip worker executed it on PR #198's branch (DEFAULT_POLICY flip, 22
> redundant `keepCardsVisible` pins deleted incl. the helper, coverage
> re-tested under explicit opt-in, one silently-vacuous relaunch test
> caught & rewritten, DESIGN §5.8 amended, manual reframed; handoff
> `orchestrator/75-default-flip.md`). Dan then authorized merging all 4
> user-facing PRs; serial merge train ran #195 → #199 → #204 → #198
> (each bumped + re-greened; #198 needed one conflict resolution —
> 06-keyboard.md only, feed.spec dissolved to byte-identical). **All 7
> run-3 items merged. Final main @ 63f3d7e**, unit 1192 / e2e 156+1.
> Unit suite 1121→1159 (highest branch), e2e 145→151 (#198's branch).
> 10 issues filed from discoveries (#194 #196 #197 #200 #201 #202 #205
> #206 #207 #208), 1 of them (#194) fixed same-run. Notables: #185 found
> TWO latent e2e traps (unclickable native quit dialog; fixture pid read
> after Playwright teardown); #75 measured its own default's cost (11
> specs); #187's reviewer caught the worker re-making the exact
> has-a-record bug the item fixes; process lesson recorded — WORKER
> BACKGROUND POLLERS DIE WHEN THE AGENT'S TURN ENDS: waits must be
> in-turn (cost two silent stalls + one zombie lock-cycle run; fold into
> /orchestrate worker prompts at source).
> **Worktree pool:** sb-wt-1/2/3 parked clean, detached @ add72e2; merged
> branches deleted; the four Dan-PR branches kept locally.
> **Single-writer rule:** this file is written ONLY by the orchestrator
> session. Workers report via handoff files in
> `.claude/work_files/orchestrator/<issue#>.md`.
>
> **Active workers** (issue → worktree → branch):
> - ~~#185 e2e AUTOCLOSE trap~~ **WORKER DONE** — PR #209 (internal,
>   test-infra) **in the merge queue**, CI running. Trap: the busy-quit
>   confirm is a main-process `showMessageBoxSync` Playwright can't click.
>   `SWITCHBOARD_AUTOCLOSE` was overloaded (timed self-quit + dialog
>   suppression) → split out `SWITCHBOARD_NO_QUIT_CONFIRM=1`; shipped
>   behavior byte-identical. Second latent trap found & fixed: fixture
>   read `app.process()?.pid` after Playwright teardown → any
>   self-closing spec died in afterEach; pid now captured eagerly (keeps
>   tree-kill). Quit guard's FIRST coverage since P1-E6-02
>   (quit-confirm.spec.ts: quit-mid-work completes; guard-on names the
>   session, Cancel holds, Quit-anyway releases). Gates: 1128 unit /
>   targeted 2/2 twice / full e2e 148+1 skip 0 fail. Worker lesson,
>   recorded for future runs: backgrounded pollers die when the agent's
>   turn ends — waits must be in-turn. Handoff:
>   `.claude/work_files/orchestrator/185.md`.
> - ~~#168 read-only workspace UI notice~~ **WORKER DONE** — PR #204
>   marked ready, **IN DAN'S QUEUE** (user-facing). Persistent
>   non-dismissible strip under the title bar from boot (banner not toast:
>   the harm lands at quit, long after a toast fades); same slot as
>   PreflightBanner; App.tsx footprint exactly one import + one render
>   line; new `workspace:isReadOnly` channel, capability-tagged, no new
>   authority. Gates: 1126 unit / 148 e2e +1 skip, 5/5 CI, 2 mutations
>   caught. Review: 0 blockers, 3 should-fixes taken (copy understated
>   the loss; race in negative e2e assertion; live region that never
>   announced). Discoveries filed: **#206** (PreflightBanner ~2.3:1 light
>   contrast), **#207** (FAILED write still log-only — same P9 shape),
>   **#208** (pop-outs never see the banner). Handoff:
>   `.claude/work_files/orchestrator/168.md`.
> - ~~#194 drain StringDecoder~~ ✅ **PR #203 MERGED** (internal; 5/5
>   green; issue #194 closed; main @ 9357428). Per-tail StringDecoder;
>   deliberately no flush (flushing emits the U+FFFD it removes); bonus:
>   watcher had NO truncation handling (shrink stalled a tail forever) —
>   6-line resync branch added. Tests bite (verified by stashing the fix).
>   Gates: 1128 unit / 146 e2e +1 skip. Discovery filed: **#205**
>   (scrollback RingBuffer trims mid-character; after #199). Handoff:
>   `.claude/work_files/orchestrator/194.md`.
> - ~~#75 P2-E9-06 presentation policy + auto-minimize~~ **WORKER DONE** —
>   PR #198 marked ready, **IN DAN'S QUEUE** (user-facing), bumped onto
>   0a22101. Pure `lib/presentation-policy.ts` (session > group > global);
>   submit seam = `submitPrompt` → store notify → SessionGrid applies via
>   E9-05's `setCardLadder`; restore IS the E9-05 reveal contract (why
>   auto-hide honors it by construction). Surfaces: titlebar ⬍ chip, rail
>   session menu + group header, 11 palette commands. **Call #1 for Dan:**
>   first e2e run failed 11 specs all shaped "submit then watch the card"
>   — the honest measurement of auto-collapse-as-default; shipped as
>   specified (§5.8), `always-visible` default is a one-line change.
>   Self-review real find: auto-hide could bury a permission-holding
>   session PERMANENTLY (revealTargets id already spent) — fixed with 4th
>   exemption (`needsHuman`). Gates: 1159 unit (+35) / 151 e2e +1 skip.
>   Discovery (report-only): revealTargets spends event ids for cards it
>   skips — revisit in E9-10. Handoff:
>   `.claude/work_files/orchestrator/75.md`.
> - **#185 e2e AUTOCLOSE trap** → `sb-wt-2` → `feature/185-e2e-autoclose`
>   (internal; e2e fixtures; dispatched after #174's worker finished)
> - ~~#174 feed keyboard a11y~~ **WORKER DONE** — PR #195 marked ready,
>   **IN DAN'S QUEUE** (user-facing). Shape: disclosure pattern — every
>   expander is a real `<button aria-expanded>` (`FeedExpander`); the
>   conversation is ONE tab stop (`role="region"`, ↑↓/Home/End/Esc roving
>   over `tabindex="-1"` buttons) so the composer stays one Tab away; both
>   rejected shapes (role=button on the box; roving over boxes) documented
>   as ARIA lies. Covers Bash coarse+IN+OUT, Edit panes, generic tool,
>   thinking, prompt pill. Rider fix: clicking an expanded prompt's TEXT no
>   longer folds it (read-not-a-click). Incidental WCAG fix: feed scroller
>   now keyboard-scrollable. DESIGN §5.10 gained the rule; manual updated.
>   Gates: 1145 unit (+21) / 147 e2e +1 skip, lock waited ~12 min behind
>   #179, nothing stolen. Discoveries filed: **#196** (duplicate
>   "Conversation" landmarks across cards), **#197** (a11y sweep: rail/
>   lamps/tab strip/Events rows are divs with onClick). Handoff:
>   `.claude/work_files/orchestrator/174.md`.
> - **#194 drain StringDecoder** → `sb-wt-3` →
>   `feature/194-drain-stringdecoder` (internal; watcher decode fix;
>   dispatched after #187's worker finished)
> - ~~#187 cardOfLive binding hardening~~ **WORKER DONE** — PR #199 marked
>   ready, **IN DAN'S QUEUE** (reclassified user-facing: three user-visible
>   corrections + manual edits ride along). Took the REAP, not the pin:
>   `tearDownLive` extracted from `dropLiveForCard`; `sessions:create`
>   reaps non-running bindings in a two-pass reap-then-adopt that fails
>   open (P6). Traced every `cardOfLive` read: the double binding itself
>   never misrouted, but two neighbors were wrong and are fixed —
>   `sessions:setTransport` said "pending" for a CRASHED session, and two
>   live transcript watches could ping-pong a card's persisted usage.
>   User-visible: stale crashed Events entry clears on respawn; stuck
>   approval bar clears on reveal-after-crash-mid-approval; transport menu
>   stops queueing behind a corpse. Review: 0 blockers, 4 should-fixes all
>   taken (one caught the worker re-making the has-a-record mistake a
>   third time). Gates: 1134 unit / 146 e2e +1 skip, mutation-checked 5
>   ways. Lock: waited out #75's legitimate 54-min hold, no steal.
>   Discoveries filed: **#200** (crashed session's watch keeps polling —
>   needs onSessionExit decision), **#201** (renderer liveToCard stale
>   entry per respawn; after #198), **#202** (streamPermissions absent
>   from ipc harness; after #199). Handoff:
>   `.claude/work_files/orchestrator/187.md`.
> - ~~#179 transcript watcher fd leak~~ ✅ **PR #193 MERGED** (internal;
>   5/5 green; issue #179 closed; branch deleted; main @ 0a22101). Both `drain` AND `readHead` leaked
>   fds on the read-error path; both now route through a `readRange` helper
>   closing in `finally`. Bonus: drain advanced offset by stat size, not
>   bytes read (shrunk file → zero-fill garbage) — fixed. Product-wide fd
>   audit: those two sites were the whole class. Tests proven to bite
>   (fail without the fix). Gates: 1126 unit / 146 e2e +1 skip. Discovery
>   filed: **#194** (UTF-8 char split across drain chunks → replacement
>   chars; wants per-tail StringDecoder). Handoff:
>   `.claude/work_files/orchestrator/179.md`.
>
> **Merge queue:** empty (PR #193 merged). Internal PRs merge on green CI;
> user-facing PRs queue for Dan.
> **Dan's queue (4):** **PR #195** (#174 feed a11y), **PR #198** (#75
> presentation policy — read its call #1 first), **PR #199** (#187
> hardening + 3 user-visible corrections), **PR #204** (#168 read-only
> banner) — all ready for review, all bumped onto 9357428, test
> checklists in the PR bodies.
> **Dispatching is WINDING DOWN:** every remaining queue item is blocked
> behind an unmerged Dan PR (#180/#196/#201/#206 behind #198; #202/#205
> behind #199; #208 behind #204; #76=E9-07 behind #198), needs a Dan
> decision (#200 onSessionExit teardown, #191 diff-pane design, #129
> milestone triage, #111 real tokens, #207 scope), or is Dan-scoping
> (E9 tail, E11/E13/E14). Once #185's PR lands (internal — orchestrator
> merges on green), the run ends with the final report.
> **Lock note:** leftover queued lock-cycle jobs from workers 185/187
> briefly re-held the machine lock after their agents finished (19:30
> hold, owner 187, 0 electron) — wasted cycles, self-releasing via EXIT
> traps, no corruption. Watch that pattern in future runs.
> Issues filed this run so far: #194 (fixed in-run), #196, #197, #200,
> #201, #202, #205, #206, #207, #208.
> **Held / needs Dan:** #111 (real tokens); #129 (milestone triage); #191
> (diff-pane syntax highlighting — needs a design call); E9 tail past #80 +
> E11/E13/E14 expansion (/pm scoping).
> **Dogfooding note (2026-08-03):** Dan uses the app daily on his work
> laptop — incoming real-usage issues are high-signal; triage into the run
> promptly.

> # 🎛 ORCHESTRATION RUN 2 — 2026-08-02→03, **CLOSED: ALL 11 ITEMS
> MERGED.** 11 items across 4 dispatch waves. 7 internal PRs
> orchestrator-merged on green CI (#178→#167, #181→#164, #184→#165,
> #188→#182, #189→#183, #190→#161, #192→#176); 4 user-facing PRs
> hand-tested + merged by Dan 2026-08-03 (#173→#91, #175→#172, #177→#74,
> #186→#170). Main @ a65f1ea. 9 issues filed from worker discoveries
> (#174 #176 #179 #180 #182 #183 #185 #187 #191) — 3 of them (#176 #182
> #183) fixed within the same run. Unit suite 1013→1121, e2e 131→145.
> Notables: check:fake-stream had TWO silent rots because it ran in no CI
> job (now guarded by an enforced local-only-or-in-CI test);
> the popout flake never reproduced but every silent save path is now
> audible; PR #177 needed a live conflict resolution after Dan's #173/#175
> merges (resumed worker, clean union, re-gated, re-merged same day).
> Process fix folded into /orchestrate at source: stale-lock stealing now
> requires process-evidence sampling, not clock age alone.
> **Worktree pool:** sb-wt-1/2/3 parked clean, detached @ a65f1ea; all
> feature branches deleted. Worker handoffs in
> `.claude/work_files/orchestrator/<issue#>.md`.
> Historical detail of the run below (kept as the log of record).
> **Single-writer rule:** this file is written ONLY by the orchestrator
> session. Workers report via handoff files in
> `.claude/work_files/orchestrator/<issue#>.md` — those are the inputs; this
> block is the output and the resume mechanism if the orchestrator dies.
>
> **Active workers** (issue → worktree → branch):
> - ~~#74 P2-E9-05 presentation ladder + reveal contract~~ **WORKER DONE** —
>   PR #177 marked ready, **IN DAN'S QUEUE** (user-facing). Gates: 1037 unit
>   (+24) / 139 e2e +1 skip (+6), lock waited behind 91/172 legitimately.
>   Ladder rungs: `collapsed` → new Collapsed strip; `tabbed` → one shared
>   dockview group; reveal-on-attention restores the EXACT slot without
>   stealing focus; `setLadder` is the seam E9-06/07 compose on. Self-review
>   took 2 blockers (a ladder move rewrote PERSISTED session data via
>   dockview group adoption; first-feed-list guard spent on the initial
>   empty array) + 7 should-fixes. **Three calls flagged for Dan in the PR:**
>   (1) `collapsed` removes the dockview panel rather than shrinking in
>   place; (2) `crashed` is NOT a reveal trigger (§5.8 lists three); (3)
>   DESIGN's ladder order makes "show more" from `tabbed` remove the panel —
>   an E9-06/07 decision. Handoff: `.claude/work_files/orchestrator/74.md`.
>   **E9 serial track HOLDS at #75** until Dan rules on the flagged calls.
> - ~~#164 check:fake-stream broken on Windows~~ ✅ **PR #181 MERGED**
>   (internal, tooling; re-greened 5/5 on post-#178 main; issue #164
>   closed; branch deleted). Root cause: the check never
>   requested the stream transport, so #153's honour-the-request change fed
>   NDJSON to a PTY cmd.exe; fixing that unmasked a second rot (#163's
>   per-block assistant messages broke the check's `.text` read) — and
>   BOTH rotted silently because check:fake-stream ran in NO CI job. Now
>   in CI beside check:pty, verified on all 3 OSes; fail-fast added on a
>   non-stream recipe. #176 confirmed NOT shared plumbing (node-pty
>   AttachConsole under ELECTRON_RUN_AS_NODE — route separately).
>   Gates: 6/6 clean check runs, 1013 unit, e2e skipped locally per
>   contract (diff loads nowhere; CI matrix green). Discoveries filed:
>   **#182** (check:adapter/hooks/transcripts also absent from CI), **#183**
>   (watcher.test.ts:457 load-sensitive unit flake). Handoff:
>   `.claude/work_files/orchestrator/164.md`.
> - ~~#170 resume never refreshes status (rail + strip)~~ **WORKER DONE** —
>   PR #186 marked ready, **IN DAN'S QUEUE** (user-facing bugfix), CI
>   running. Root cause fixed at source: `sessions:cards` is a join whose
>   BINDING half (card gaining/losing its live session) never pushed — only
>   status changes did, and a resume has no transition. All `cardOfLive`
>   mutations now route through bindLive/unbindLive → `sessions:cardsChanged`
>   → App's existing refresh. No presentation/dockview file touched (only
>   App.tsx overlaps PR #177, different effect). Gates: 1016 unit / 132 e2e
>   +1 skip; all 4 new tests mutation-checked. Manual: 02-sessions.md
>   updated. Discovery filed: **#187** (double cardOfLive binding on
>   crash-respawn — correct but implicit). Handoff:
>   `.claude/work_files/orchestrator/170.md`.
> - ~~#182 wire remaining check scripts into CI~~ ✅ **PR #188 MERGED**
>   (internal; 5/5 green; issue #182 closed; main @ 982d646). All three
>   checks (adapter/hooks/transcripts) are LOCAL-ONLY — each drives a real
>   `claude` model turn, which CI can't do without violating the no-API-key
>   constraint. Decision written in ci.yml AND enforced: new
>   `check-scripts.test.ts` guard (+8 tests, mutation-tested 3 ways) fails
>   the build if a future check:* script is neither in CI nor exempted with
>   a reason. All three checks hand-verified PASS against claude 2.1.220 —
>   no #164 repeat. testing.md stale guidance fixed. Handoff:
>   `.claude/work_files/orchestrator/182.md`.
> - ~~#176 check:pty AttachConsole noise on Windows~~ **WORKER DONE** — PR
>   #192 (internal, tooling) **in the merge queue** behind #190. Root cause
>   PROVEN: node-pty `kill()` forks its console-list agent then destroys
>   the pseudoconsole on the next line — agent boots too late,
>   AttachConsole dumps on inherited stderr; node-pty's own 5s fallback
>   covers it. Not fixable at source without `useConptyDll` (production
>   packaging change — follow-up, not here). Fix: buffering state-machine
>   filter pinned to node-pty's exact source lines; first deviation prints
>   the whole buffer verbatim; RAW_STDERR escape hatch. Loud-failure proven
>   twice (incl. a genuine dump with the SAME SHAPE as the benign one —
>   kept). Gates: 1068 unit (+37 filter/+8 runner tests), 13 consecutive
>   clean check runs incl. 40-PTY under load. Two review rounds found 3
>   real line-eating bugs + an unbounded counter — all fixed and pinned.
>   Handoff: `.claude/work_files/orchestrator/176.md`. `sb-wt-1` idle —
>   ALL WORKERS DONE.
> - ~~#183 merge note~~ ✅ **PR #189 MERGED** (issue #183 closed; its flake
>   was re-confirmed 3/3 on clean main by #176's CI run — merged first for
>   exactly that reason).
> - ✅ **PR #192 MERGED** (issue #176 closed; main @ ece5e61). **INTERNAL
>   MERGE QUEUE DRAINED — 7 internal PRs merged this run** (#178 #181 #184
>   #188 #189 #190 #192). Dan's four PRs bumped
>   onto ece5e61 at ~21:45, re-greening in parallel — orchestrator
>   confirms green, then pings Dan (dispatching FROZEN). Worktrees
>   sb-wt-1/2/3 parked clean, detached @ ece5e61; merged local branches
>   deleted.
>   HELD still: #174 (behind unmerged #173), #179 (may be implicated by
>   #183 in flight), #180 (watcher.test collides with #183 in flight),
>   #129 (needs milestone triage).
> - ~~#91 boxed tool blocks + no dot on prose~~ **WORKER DONE** — PR #173
>   marked ready, **IN DAN'S QUEUE** (user-facing; orchestrator never merges
>   it). Gates: 1015 unit (+2 files) / 132 e2e +1 skip, e2e under the lock.
>   Tool blocks get a bordered `ToolBox` (whole box toggles; inner controls
>   carry `data-no-toggle`; drag-select ≠ click); assistant prose loses the
>   dot, keeps the 6px gutter. DESIGN.md §5.10 amended; manual updated. Two
>   deliberate calls written into DESIGN: Todos boxed but non-toggling;
>   thinking unboxed with dot. One unrelated flake seen once
>   (popout-geometry:149 = known #165). Discovery filed as **#174** (feed
>   has no keyboard path to expanders — a11y item). Handoff:
>   `.claude/work_files/orchestrator/91.md`.
> - ~~#167 EBUSY phantom (stream-service.test.ts afterAll)~~ ✅ **PR #178
>   MERGED** (internal, test-only; all 5 jobs green; issue #167 closed;
>   branch deleted; main @ 93eabe4).
>   Root cause PROVEN: Windows children hold their cwd lock until
>   reaped; bare spawn→kill→rmSync repro'd EBUSY 20/20, await-exit-first
>   0/40. Fix: reapAll() awaits every exitCode in afterEach/afterAll +
>   rmSync retry layer; same race fixed in watcher.test.ts. Gates: 20/20
>   targeted / 3/3 full suites (1013 unit) / 131 e2e +1 skip under lock.
>   Discoveries filed: **#179** (PRODUCT fd leak — watcher.ts:907 openSync
>   with no finally pins a user's transcript for the app lifetime), **#180**
>   (temp-dir leaks: stream.spec 502 dirs, watcher.test ~94/run). Handoff:
>   `.claude/work_files/orchestrator/167.md`.
> - ~~#161 Monaco diff pane e2e coverage~~ ✅ **PR #190 MERGED** (internal,
>   e2e-only; re-greened 5/5 on post-#189 main; issue #161 closed). Key finding:
>   the naive spec was VACUOUS — Monaco silently falls back to main-thread
>   rendering when its worker dies, so a CSP regression leaves the tab
>   looking perfect; the spec now asserts decorations AND the absence of
>   Monaco's own worker-creation warning (proved by sabotage: only that
>   line goes red). New spec 10/10 across two campaigns; full suite 133
>   e2e +1 skip twice; zero leaked temp dirs. Dev-mode stretch skipped
>   (not cheap — CSP_DEV stays uncovered, noted in #161 closure via PR).
>   Discovery filed: **#191** (diff pane has NO syntax highlighting —
>   one-line fix is a trap, needs a design call). Process fix applied at
>   source: stale-lock rule in the /orchestrate skill now requires
>   process-evidence sampling, not clock age alone (#183 held the lock 91
>   min, live). Handoff: `.claude/work_files/orchestrator/161.md`.
>   `sb-wt-2` idle — NO new dispatch (stopping-point agreement with Dan).
>
> **Dan's queue (user-facing PRs, hand-test lists in the PR bodies):**
> - **PR #173** (#91, boxed tool blocks + no dot on prose) — ready, **all 5
>   CI jobs GREEN**.
> - **PR #175** (#172, app version + build identity) — ready, **all 5 CI
>   jobs GREEN**.
> - **PR #177** (#74, presentation ladder + reveal contract) — ready,
>   **all 5 CI jobs GREEN**. Three flagged calls in the PR body need Dan's
>   ruling before E9-06 dispatches.
> - **PR #186** (#170, resume status refresh) — ready.
> **AGREED WITH DAN 2026-08-02 (~19:30):** he waits for a clean stopping
> point. Sequence: the three in-flight internal items (#161/#183/#176)
> finish → orchestrator merges them → final bump + re-green of the four
> queued PRs → **dispatching STOPS** and Dan is pinged to test. Suggested
> merge order for Dan: **#175 first** (build stamp makes every later test
> build self-identifying), then #173, #186, then #177 (three flagged calls
> to rule on). All four PRs were bumped onto 982d646 at ~19:25; one more
> bump follows the last internal merge.
> - ~~#172 P2-E15-15 app version + build identity~~ **WORKER DONE** — PR
>   #175 marked ready, **IN DAN'S QUEUE** (user-facing). Gates: 1040 unit
>   (+27 files) / 134 e2e +1 skip / check:pty PASS; SHA verified in both
>   bundles. Build stamps SHA+branch+dirty+time via electron-vite `define`
>   (`src/build/git-identity.ts`, Node-only so child_process can't leak into
>   the renderer); title-bar stamp → About panel + palette command +
>   boot-log line + **build age** (the field that actually catches a stale
>   `out/`). Self-review fixed two real defects pre-PR (Ctrl+Space could
>   jump behind the About modal; panel click stranded focus, killing
>   Escape). Manual: `11-troubleshooting.md`. Worker also repaired
>   plan-file damage (#172's insertion had swallowed the `**E15 exit:**`
>   lead-in). Discovery filed as **#176** (check:pty passes but prints an
>   AttachConsole stack trace). #165 flake seen once here too, passed on
>   re-run. Handoff: `.claude/work_files/orchestrator/172.md`.
> - ~~#165 popout-geometry e2e flake under load~~ ✅ **PR #184 MERGED**
>   (internal + observability; 5/5 green on post-#181 main; issue #165
>   closed; branch deleted; main @ 748d3f2). Could NOT reproduce (30 loaded + 12
>   saturated repeats green); ruled out registration-race and slow-relaunch
>   by measurement. Real finding: every popout-losing path was SILENT —
>   `WorkspaceStore.save()` swallowed all write errors (leading suspect:
>   Windows tmp+rename losing to a scanner, EPERM/EBUSY — now warns, still
>   fails open); SessionGrid restore + quit flush also made audible. A
>   product "fix" was built then REVERTED (would lose real cards every quit
>   to rescue a rare popout — reasoning in the PR). Spec: six failure modes
>   fail by name, 18/18 clean + 4/4 under 32-burner saturation, attaches
>   switchboard.log. Gates: 1015 unit / 131 e2e +1 skip. Discovery filed:
>   **#185** (e2e never sets SWITCHBOARD_AUTOCLOSE — modal trap);
>   watcher:457 corroboration added to #183. Handoff:
>   `.claude/work_files/orchestrator/165.md`.
> - ~~#183 watcher.test.ts:457 load-sensitive unit flake~~ **WORKER DONE**
>   — PR #189 (internal, test-only) **in the merge queue**, CI running.
>   Root cause MEASURED: the test asserts a negative inside a 120ms
>   wall-clock deadline; under load its sleep(60) overshot to 182ms, the
>   fail-open fallback bound as designed, assertion landed outside its own
>   window. Repro'd deterministically (event-loop stall) AND at unfixed
>   main under burners (5/7 failed). Fix is test-only: fake Date for the
>   pre-deadline half, then hand the clock back; assertions strengthened
>   (candidateSeen proves refusal, not not-looked-yet). 20/20 saturated,
>   1023 unit, 131 e2e. Revert- and stall-proofed. **#179 NOT implicated;
>   no product code changed.** Handoff:
>   `.claude/work_files/orchestrator/183.md`. `sb-wt-3` idle — NO new
>   dispatch (stopping-point agreement with Dan).
>
> **Merge queue:** empty. All three items are user-facing → PRs will be
> marked ready and QUEUED FOR DAN, never merged by the orchestrator.
> Rebase-after-every-merge rule applies if anything lands on main mid-run.
>
> **Next up after this wave:** small-fix pool #170 #168 #167 #165 #164 #161;
> E9 serial track continues #75 (E9-06) after #74 lands; #129 (transcript
> scan give-up) needs milestone triage. **#111 still HELD** (real tokens —
> ask Dan). E18-11…16 unfiled behind S-11 probes; E9 tail past #80 and
> E11/E13/E14 expansion need Dan (/pm scoping).

> # 🎛 ORCHESTRATION RUN 1 — 2026-08-02, **CLOSED: ALL SIX ITEMS MERGED.**
> 6 work items dispatched to parallel Opus workers, 6 on `main` same day:
> #109→PR#160, #145→PR#162, #110→PR#166 (internal, orchestrator-merged);
> #140→PR#163, #73→PR#169, #90→PR#171 (user-facing, Dan hand-tested +
> merged). **#156 closed** (fixed by #163, both transports). 7 issues filed
> from worker discoveries: #161 #164 #165 #167 #168 #170 #172.
> **#140 took three rounds and each paid rent:** round 1 = the fake-blind
> composer bug (Enter fed the autocomplete, commands never sent — BOTH
> transports) + the real per-block assistant message shape; round 2 = Dan
> was hand-testing a stale `out/` build of main, which spawned #172/E15-15
> (app version + build identity) AND a no-click visibility e2e. Lesson
> normalized: a fake must be able to FAIL the way reality fails, and a test
> that teaches an unnatural keystroke can't see the natural one break.
> **Worktree pool:** sb-wt-1/2/3 parked clean, detached on 2b8d217; merged
> local branches deleted. **`npm ci` in a fresh worktree does NOT install
> Electron's binary** — run `node node_modules/electron/install.js` after
> (fold into the /orchestrate skill's recipe).
> Worker handoffs remain in `.claude/work_files/orchestrator/<issue#>.md`.
> Historical detail of the run below (kept as the log of record).
>
> **Active workers** (issue → worktree → branch):
> - ~~#140 P2-E18-10 Feed from typed messages~~ **WORKER DONE** — PR #163
>   marked ready, IN DAN'S QUEUE (user-facing; orchestrator never merges it).
>   Gates: 888 unit (+48) / 114 e2e +1 skip. #156 asserted twice (unit+e2e)
>   AND fixed for PTY too via shared `local_command` derivation. Handoff:
>   `.claude/work_files/orchestrator/140.md` (8-step hand-test list, also in
>   the PR body).
> - ~~#73 P2-E9-04 Urgency strip + delayed urgency reset~~ **WORKER DONE** —
>   PR #169 ready, IN DAN'S QUEUE (user-facing). Gates: 868 unit (+28) /
>   116 e2e (+5). Two calls flagged for Dan in the PR body: no off switch
>   for the strip, and only Ctrl+Space lights a lamp (not click). Urgency
>   store shaped for the later E9 items; pinned-first inherited from rail
>   order rather than a second sort. Handoff:
>   `.claude/work_files/orchestrator/73.md`.
>   **#74 deliberately NOT dispatched yet** — it extends #73's store while
>   Dan has two overrulable calls open on it; the serial E9 track resumes
>   after Dan merges #169. `sb-wt-1` parked on detached main (fa8eed7).
> - ~~#145 e2e flake: slash popup second open~~ **WORKER DONE** — PR #162 in
>   the merge queue below. Diagnosis: cause 1 confirmed two ways (`fill('')`
>   never reaches React on a textarea — Playwright's own source; plus a stale
>   rAF caret write reproducing the exact CI symptom); cause 2 ruled out and
>   the fail-open scan made observable (warn log + switchboard.log attached
>   on e2e failure). Target spec 6/6 clean + 4/4 under CPU saturation.
> - ~~#90 Terminal-focus accelerators~~ **WORKER DONE — ALL WORKERS DONE.**
>   PR #171 ready, IN DAN'S QUEUE (user-facing). Gates: 913 unit / 120 e2e
>   +1 skip. P7 verified against the shipped CLI's own keybinding table
>   (both chords unbound); allowlist growth rule written at the definition
>   site; popouts covered; fail-open handshake added after review found a
>   swallow-before-subscribe hole. Handoff:
>   `.claude/work_files/orchestrator/90.md`. `sb-wt-2` parked (fa8eed7).
> - ~~#109 P2-E15-12 Header-based CSP~~ **WORKER DONE** — PR #160 in the
>   merge queue below.
> - ~~#110 P2-E15-13 Workspace schema migration hook~~ **WORKER DONE** — PR
>   #166 in the merge queue below. Read-only-safe = boots fail-open but
>   refuses writes (the lossy overwrite is the harm). Includes two latent
>   `store.ts` bugs fixed in passing, both tested (non-object JSON loaded
>   empty with no `.corrupt` backup then got overwritten; fresh-start state
>   aliased module-level `EMPTY`, leaking groups across stores). Worktree
>   `sb-wt-3` idle after merge — next dispatch is #74 when #73 lands.
>
> **Status:** #140, #145, #110 workers running. #109's worker finished: all
> gates green (858 unit / 115 e2e), handoff in
> `.claude/work_files/orchestrator/109.md`.
> NOTE: Dan's tooling PR #159 landed on main mid-run — PR #160's branch was
> updated from main (CI re-running); #110's branch is cut from e09ba68.
> Workers #140/#145 branch from de8dcdc — their PRs will need the same
> update-from-main before merge (no expected conflicts; #159 touched only
> .claude/settings.json + .gitignore).
>
> **Merge queue:** Internal PRs squash-merged on green CI, one at a
> time, rebase-after-every-merge. User-facing PRs marked ready and QUEUED FOR
> DAN, never merged by the orchestrator.
> - ✅ **PR #160 (#109, internal) MERGED 2026-08-02**, all 5 jobs green on
>   the updated head; issue #109 closed; branch deleted. One flagged
>   DESIGN-reading divergence (meta tag is a BUILD-TIME backstop for the
>   `file://` fallback, not dev-only — dev-only would re-break Vite's
>   preamble; ~15-line revert if Dan prefers the literal reading). Post-merge
>   sanity for Dan is in PR #160's body; the Monaco diff pane is the one
>   surface with no automated coverage (filed #161).
> - ✅ **PR #162 (#145, internal) MERGED 2026-08-02**, all 5 jobs green on
>   the updated head; issue #145 closed; branch deleted. Note for Dan: this
>   internal merge included two small renderer fixes (composer caret
>   rAF→useLayoutEffect — the flake's product-side cause — and scan
>   warn-logging), not only test code.
> - **PR #163 (#140, user-facing)** — on post-#162 main, **all 5 jobs GREEN.
>   Ready for Dan** — nothing pending on it. (If another internal merge lands
>   first, the orchestrator will bump + re-green it again.)
> - ✅ **PR #166 (#110, internal) MERGED 2026-08-02**, all 5 jobs green on
>   the updated head; issue #110 closed. `sb-wt-3` parked on detached main
>   (fa8eed7), idle — reserved for #74 when #73 lands.
> - **PR #163 GREEN on post-#166 main** (all internal merges done) — ready
>   for Dan, nothing pending.
>
> **Filed mid-run:**
> - #161 (Monaco diff pane has zero e2e coverage; dev-mode coverage gap noted
>   inside) — from #109's handoff.
> - #164 (`npm run check:fake-stream` broken on Windows, pre-existing on
>   main — cmd.exe banner leaks into the pipe) — from #140's handoff.
> - #165 (popout-geometry.spec.ts:149 flaked under load — same load-sensitive
>   class #145 just fixed for the slash popup; #145's staging pattern applies)
>   — from #145's handoff.
> - #167 (stream-service.test.ts afterAll rmSync EBUSY race on Windows —
>   phantom "1 file failed, 0 tests failed" unit runs) — from #110's handoff.
> - #168 (workspace read-only mode is log-only; a P9 surface —
>   `isReadOnly()` is the seam) — from #110's handoff.
> - #170 (resuming a suspended session never refreshes status — rail and
>   strip both stay "suspended"; `refreshSessions` only fires on a change
>   event a resume doesn't emit) — from #73's handoff.
>
> **Worktree gotcha (hit every fresh worktree):** `npm ci` does NOT install
> Electron's binary (`node_modules/electron/` lacks `dist/`) — `npm run dev`
> / `e2e` die with "Electron uninstall". Fix: `node
> node_modules/electron/install.js` (instant, from cache). Relayed to both
> running workers; fold into the /orchestrate skill's worktree recipe when
> the run ends.
>
> **Dan's queue: ALL CLEARED 2026-08-02 — Dan merged #163, #169, #171.**
> Only leftover: PR #157's 6-item hand-test list was never run; its code has
> been on main since morning. Historical entries follow.
> 1. **PR #163 (#140) — ROUND 2 RESOLVED: Dan was hand-testing a STALE
>    BUILD OF MAIN.** The main checkout's `out/` was built 08:11 from
>    de8dcdc — zero `local_command` code; the collapsed `/usage` stub is
>    main's original #156 bug faithfully reproduced. Dan's own failing
>    session transcript contained the output all four times. The branch,
>    actually built, renders `/usage` figures visibly in BOTH transports —
>    verified against the real CLI. Round 2 still paid rent: the transcript
>    half of #156 had NO e2e (unit only — "on screen" vs "in a data
>    structure" was untestable); a new e2e asserts the output visible with
>    no click, scoped to the assistant-prose renderer so text hidden in the
>    collapsed pill cannot satisfy it. Gates: 930 unit / 121 e2e + 1 skip.
>    Filed #172 (no build identity in the UI — the ambiguity that cost the
>    cycle). **Dan's re-test — BUILD THE BRANCH FIRST:**
>    `cd C:/Projects/sb-wt-1 && npm run build && npm start`, then `/usage`
>    + one Enter in both modes, `/us`+Tab, streamed paragraph (no duplicate
>    copy). Round-1 history below.
>    Dan found no slash command ran in a Direct session (2026-08-02). Worker
>    measured before touching: the CLI was INNOCENT — all five commands
>    (/usage /cost /context /model /agents) return full output over the
>    stream with our exact flags. **The composer's autocomplete popup was
>    claiming Enter to confirm a completion** — a fully-typed `/usage` +
>    Enter became `/usage ` and ran nothing, in BOTH transports (Terminal
>    mode only worked because you type into the terminal). The worker's own
>    e2e had hit the wall and worked AROUND it (Escape first) — the test
>    taught the unnatural keystroke, so it couldn't see the natural one
>    fail. Fix: Enter runs a fully-typed command, Tab still completes.
>    Same probe run also exposed a second fake blindness: the real CLI
>    emits ONE assistant message PER content block mid-stream (all index 0)
>    — the index-only reconcile would have duplicated every block after the
>    first; now reconciled by index then kind. Fake upgraded to emit the
>    measured reality; findings in
>    `spike/findings/s-11-slash-commands-and-message-shape.md`.
>    Gates: 930 unit / 120 e2e + 1 skip; CI re-running on the fixed head.
>    **Dan's re-test:** `/usage` + Enter ONCE (also /cost /context /model
>    /agents); `/us` + Tab completes without sending; same checks in
>    Terminal mode; a streamed paragraph has NO duplicate copy underneath.
> 2. **PR #169 (#73, urgency strip)** — ready for review, **all 5 jobs GREEN
>    on post-#166 main**. Hand-test list in the PR body;
>    the two judgment calls to confirm or overrule: strip has no off switch
>    (§5.8 persistent), and only Ctrl+Space triggers the lingering lamp.
> 3. **PR #171 (#90, terminal accelerators)** — ready for review, **all 5
>    jobs GREEN on post-#166 main**. Headline hand-tests: from
>    terminal focus, Ctrl+Shift+P opens the palette and Ctrl+Space jumps to
>    the session needing attention (main window AND popout); every other key
>    still reaches the CLI (Ctrl+R history search etc.).
> 4. (carried over, pre-run) PR #157's 6-item hand-test list — still unrun.
>
> **Up next (queue analysis):** Feed track is serial #140 → #91 → verify #156
> closes. E9 (#73–#80) is one serial track — starts after wave 1 frees a
> worktree. #110 (workspace schema migration) and #90 (keyboard reachability)
> are candidates for wave 2. #111 (re-measure S-07 concurrency) HELD — it runs
> real sessions on the subscription; asking Dan before dispatching. E18 tail
> (E18-11…E18-16) unfiled behind S-11 probes — not filed without Dan.

> *(superseded 2026-08-02 — this block used to say "next is /next-item 140";
> #140 shipped in orchestration run 1, see the START HERE block at the top)*

**#139 (P2-E18-09) DONE — MERGED 2026-08-02 as PR #157**, all 5 CI jobs green.
Gate: lint + typecheck + **840 unit (+26)** + **111 e2e (+3)**. Dan merged.
**E18 is 10 of 11 filed items done; only #140 remains.**
**[user] hand-testing NOT yet run** — the 6-item list is in PR #157's body as
checkboxes. The one that matters most is #4: in a FRESH Direct session type `/`
BEFORE prompting it — you should get the curated list, not an empty box. That is
the behaviour most likely to look like a bug when hit cold.

> # ▶ DECISION 2026-08-02 (Dan): **TERMINAL MODE IS BEING DROPPED.**
> Verbatim in spirit: *"We're going to be dropping Terminal Mode anyway once we
> get Direct Mode completely tested here and working."* Said while declining to
> hand-test a change in Terminal mode — so it is also an instruction about where
> testing effort goes.
> **The condition is the only one and it is real: Direct mode tested and working
> in real use.** Nothing is deleted before that, and **PTY mode must keep
> working the whole way** — it is the fallback while Direct mode is under test.
> **What changed in the plan** (`docs/plans/05-transport-migration.md`, decision
> block at the top; DESIGN §5 amendment; manual `12-direct-mode.md`):
> - **E18-16 stops being a decision and becomes an execution** — flip the
>   default and delete the PTY stack. It used to ask *whether*.
> - **E18-11 (the choosers) changes job the same way S-11 did.** It was a
>   go/no-go — "if either chooser is CLI-kept, the terminal stays". It is now a
>   SCOPING probe: a CLI-kept chooser is a gap to build for or accept, not a
>   veto. Still worth running, and still before E18-16.
> - **Terminal-mode regressions stop being blocking.** Worth knowing, not worth
>   stopping for.
> - **P7 is NOT relaxed.** Ctrl-R, vim mode and the `/resume`·`/rewind`·
>   `--from-pr` pickers are rebuilt properly or dropped and SAID so.
>   Screen-scraping stays rejected precedent. The terminal going away makes
>   honesty mandatory, not faking permissible.

> ## 🐛 NEW ISSUE #156 — `/usage` shows NOTHING in a Direct session (Dan, 2026-08-02)
> **Measured, and the obvious diagnosis was WRONG.** The comfortable answer —
> *"`/usage` is a TUI display the CLI keeps for itself, and P7 forbids faking
> it"* — is false. The CLI emits it as a completely ordinary turn:
> `system:init -> assistant -> result:success`, full text in the `assistant`
> message. **Nothing is withheld.**
> **The Feed reads the JSONL TRANSCRIPT, and the transcript disagrees with the
> stream.** The same turn writes `user` + `user(isMeta)` + a **`system`** entry
> (`subtype:"local_command"`, output in `content` wrapped in
> `<local-command-stdout>`) and **no `assistant` entry at all**. We render
> assistant/user/tool blocks, so the text is dropped.
> **It is NOT a Direct-mode regression.** The Feed drops it in BOTH transports;
> in Terminal mode the CLI also draws it in the terminal, so the gap was
> invisible. **Direct mode did not break this — it removed the surface that was
> hiding it.** Expect more of this shape as the terminal goes.
> Why the rest worked: **`/startup` is a skill** (expands to a real prompt → real
> assistant turn), **`/clear`** is handled by us, and **the done-sound played**
> because `result` arrived — the completion signal and the content travel by
> different routes and only one was broken.
> **#140 (the next item) fixes it** by moving the Feed onto the stream; a note on
> #140 says to ASSERT that rather than assume it. A smaller fix that helps both
> transports today: render `system:local_command`, stripping the wrapper.
> **First measured case where the transcript is strictly POORER than the stream,
> not merely slower** — the migration's "the transcript stack survives untouched"
> claim still holds, but it was never a faithful record of what the user SAW.
> Probe `spike/s11/probe-local-commands.cjs` (NOT the planned probe 2 — that is
> still plan mode, unstarted); findings
> `spike/findings/s-11-local-slash-commands.md`.

> ## #139 — the composer's command list now comes from the CLI in Direct mode
> `CLAUDE_BUILTIN_COMMANDS` is 40 hand-curated builtins the file itself calls
> "a maintenance chore". In Direct mode the CLI advertises the real set, so the
> **CLI's list is the SET and our `.claude/` scan becomes a description-and-
> provenance lookup over it** — `/startup` keeps its badge and its description,
> a stale curated entry disappears, and a plugin command we could never
> enumerate shows up.
> **Contract READ, not guessed** (the standing rule, and it paid): the two
> payloads disagree on fidelity. `system:init.slash_commands` is **bare
> names**; `system:commands_changed.commands` is **objects** with
> `description`/`argumentHint`/`aliases`. Both confirmed in the shipped
> extension bundle. Its richer list actually comes from the **`initialize`
> control-request RESPONSE**, which we do not send — so init being names-only
> is by construction, not by accident. Noted as future work, not absorbed.
> **The fake could not have caught a merge-vs-replace bug** and now can: its
> fallback list was a strict SUBSET of what its `init` advertised, so both
> designs rendered an identical popup. Added `curated-only`, absent from the
> fake's `init` on purpose. **Third time this exact hole has been found in a
> fake in three days** (#153's transport, #154's `!hang`, now this) — the
> pattern is that a fake built to make the happy path work cannot express the
> NEGATIVE half of a claim.
> **Two behaviours inherent to the transport, not bugs:** a fresh Direct
> session shows the fallback list **until its first prompt** (the CLI emits
> nothing at spawn — S-11), and descriptions are thinner for builtins we do not
> curate.
> **Review found 5 should-fixes, all taken.** The two worth remembering: both
> stream consumers had been coalesced into ONE `onStreamMessage` listener,
> which defeats the manager's per-listener try/catch and would have let a throw
> in the permission router silently freeze the command list for ever; and an
> **empty** advertised list wiped the popup while a malformed one correctly kept
> the prior — the fallback now covers both, since the done-when is "rather than
> showing nothing" and an empty popup is empty either way.
> **Every new test was revert-proofed by breaking the code and watching it
> fail** — including the two the review asked for, one of which (`forgetSession`
> wiring) could be deleted entirely with the whole suite still green.
>
> ### ⚠ Its CI found TWO REAL DEFECTS in an unrelated test — recorded on #145
> macOS unit went red twice, on two DIFFERENT tests, both in
> `discovery-scheduler.test.ts`, neither related to this item. Both were genuine,
> not load:
> 1. **A 10,000ms `waitFor` inside vitest's default 5,000ms `testTimeout`.** The
>    budget was fiction — killed at 5s, so a slow runner produced a TIMEOUT
>    instead of the test's own assertion. **That line WAS the #145-class fix from
>    #149** (a fixed 200ms sleep replaced by wait-for-the-condition) — and was
>    then capped below its own budget by a default nobody looked at. The sibling
>    test in the same block had its `}, 20_000)`. A sweep of every wait budget in
>    `src/**/*.test.ts` found **no other instance**.
> 2. **`waitFor` RESOLVES EITHER WAY, and the seed wait was non-asserting.** The
>    append test needs its path KNOWN before it measures; it waited 2s for any
>    event and carried on regardless. On a loaded macOS runner the event never
>    came, so it measured an UNKNOWN path, the root went dirty, and the assertion
>    inverted — reading `expected true to be false`, which points at the property,
>    **the one place the fault was not.** Now 10s, and on darwin a miss THROWS
>    naming the setup.
>
> **The finding underneath, and the one that matters most:** three macOS runs
> gave `5254ms fail` → `2256ms fail` → **`90ms pass`**. Ninety milliseconds for a
> file with two multi-second real-`fs.watch` tests: they **early-returned via
> `watchFailed`**. **macOS CI is non-deterministic about whether recursive
> `fs.watch` registers at all**, so this file's green is indistinguishable from a
> skip. That is the #107 class one level up — not a test that cannot fail, but a
> test whose PASS is indistinguishable from having tested nothing.
> ⇒ **Neither fix has actually been exercised on CI.** Correct by construction
> (one was provably impossible to pass), unproven in the environment that breaks
> them. Recommendations for the sweep are on **#145**, including making
> `watchFailed` skips visible instead of silently green.
**#152 and #155 MERGED**, 5 CI jobs green on each. **#153 and #154 CLOSED.**
Gate at merge: lint + typecheck + **814 unit** + **108 e2e**.

> ## ⚠ #153 IS THE MOST INSTRUCTIVE FAILURE OF THE EPIC — READ THIS
> **Dan found it by using the feature. Every automated layer was green.**
> The setting saved, said "takes effect on next start" — and **every route to a
> next start destroyed it**: the only user-facing restart is the card's ✕, which
> is `sessions:closeCard` → `persist.remove(cardId)`. The choice died with the
> card. **A feature that could not work, shipped behind a full green suite.**
> **Why no test caught it:** `setTransport` was unit-tested for persistence AND
> the pending flag; the stream e2e drove a full session end to end. But **the
> e2e launched with stream already selected by an env var**, so nothing ever
> walked *set it → restart → use it*. The parts were each verified; the product
> did not work.
> **A second, compounding cause: the FAKE ignored the requested transport.** It
> always returned a stream recipe, so no test could exercise SWITCHING even in
> principle. **A fake that cannot say "no" to a request cannot test the
> request.** It now honours `options.transport` exactly as the real adapter
> does, and the stream specs pass `SWITCHBOARD_TRANSPORT=stream` to ASK.
> **And I misread my own control while helping him test**, telling him
> "Transport: Terminal" meant he was in Direct. It showed the CURRENT mode; in a
> menu, entries read as commands. Now `Transport: {now} — switch to {next}`.
> **Two more self-inflicted bugs found on the way, both from shell-passed
> strings:** i18n here is **ICU (single-brace `{now}`)** and I wrote i18next's
> `{{now}}`, which rendered the raw template; and earlier, `cat <<'EOF'` ate
> backslashes in two e2e regexes. **Write TS and locale strings with
> Write/Edit, never through a heredoc.**
> **TWO MORE BUGS DAN FOUND ON THE NEXT TRY, both shipped by the same blind
> spot — nothing had ever LOOKED at a running stream session:**
> 1. **The terminal-handoff bar rendered in a mode with no terminal.** A freshly
>    restarted Direct session showed *"Claude is showing a start-up dialog …
>    appear only in the terminal"* over an **[Open Terminal]** button, right next
>    to a Terminal tab correctly saying there is no terminal. Two surfaces in one
>    window contradicting each other. `terminalHandoff` had no notion of
>    transport and EVERY branch of it routes to a terminal. The `startingLong`
>    branch is provably false there — S-10 measured that stream mode draws no
>    startup dialog at all.
> 2. **The session was genuinely stuck reporting `starting`** (the bar needs 8s
>    of it). **My bug from #135:** `transport-ready` was deferred by
>    `setImmediate` so `create()` would return first — but the renderer learns a
>    session's id from the IPC RESPONSE, which is far slower than a tick, so the
>    only `starting -> idle` push it would ever get was filtered out for an id
>    nobody knew yet. `cardOfLive` is not populated until create returns either.
>    **PTY sessions never showed it** because their first status change comes
>    from a hook seconds later. **Stream readiness is IMMEDIATE, and immediate is
>    exactly what a subscribe-then-push design cannot deliver.** Now applied
>    synchronously, so the RETURNED record already says idle — which is what the
>    renderer actually reads. The test that asserted the old ordering was
>    asserting the bug; it now checks the thing that actually mattered (a
>    listener firing during create sees a COMPLETE record).
>
> **A THIRD round, after Dan confirmed the `.claude` write WORKS by hand:** the
> setting did not survive closing and reopening the **app**. Cause: the
> create-time card write **rebuilt the persisted record field by field**, so
> `transport` was dropped on EVERY session start — including the one at launch.
> **Exactly the same defect shape as `reason` vanishing from the approval queue
> hours earlier.** Now it spreads `prior` and overrides only what a start
> actually decides, so a field is KEPT unless someone means to change it.
> Revert-proofed, plus an e2e that relaunches the built app.
> **The rule, twice earned in one day: field-by-field copying makes a NEW field
> a decision (good) and a FORGOTTEN field silent (the cost). Spread-then-override
> pays that cost the other way round.**
>
> ## ✅ THE EPIC'S PURPOSE IS CONFIRMED BY HAND (Dan, 2026-08-01)
> Writing to a project's `.claude/` folder in Direct mode **popped ONE approval
> in the session window; he approved it; the file was written.** No second
> terminal prompt, no discarded answer. That is the 31 July bug, fixed and
> verified by the person who reported it.
>
> **#154 FIXED — Dan gave a reliable repro: in Direct mode the Stop button did
> NOTHING.** Cause: `onClick` wrote **Esc to the PTY**, and a stream session has
> no PTY, so `ptys.get(id)?.write()` was a silent no-op and the turn ran to
> completion. **THIRD instance of one class — a PTY-shaped affordance surviving
> into a mode with no PTY** (the others: the Terminal tab, the hand-off bar).
> Now sends an `interrupt` control request, with the shape **read out of the SDK
> in the extension bundle, not guessed** (`interrupt()` there is
> `request({subtype:'interrupt'})`, wrapped as `{type:'control_request',
> request_id, request}`; the reply carries `still_queued`). Try-then-fall-back
> like `submitPrompt`, so the renderer stays transport-ignorant.
> **Scope note: this is a slice of E18-12, which is S-11-GATED.** What the CLI
> actually DOES on interrupt is still unmeasured. It ships anyway because the
> alternative was a dead button; the rest of E18-12 (`set_permission_mode`,
> `set_model`, `rewind`) stays behind the gate.
> The fake gained **`!hang`** — start a turn and never finish it — because
> `working` is the only state the stop button renders in and nothing else could
> hold a session there. The tooltip said **"(sends Esc)"**, which is false in
> Direct mode; it now names the EFFECT, not the mechanism.
Next after this: **#139 (P2-E18-09)** — slash commands from `system:init`.
**E18 IS 9 OF 11 DONE, ALL MERGED with 5 CI jobs green:** #131 → PR #141 ·
#132 → PR #142 · #133 → PR #143 · #134 → PR #144 · #135 → PR #146 · #136 →
PR #147 · #137 → PR #148 · #138 → PR #150 · **#149 → PR #151 (the first
user-visible surface — ⋯ menu → Transport: Direct, and a manual page)**.
**Remaining filed: #139** (slash commands from `system:init`) and **#140** (Feed
from typed messages).

> ## ✅ S-11 PROBE 1 COMPLETE — 8h, CLEAN PASS. **Findings note written:
> `spike/findings/s-11-long-run-stability.md`.**
> Survived the full 8h and was still answering; **25 turns sent, 25 completed;
> 832 lines, 0 parse failures; 0 keep_alives; child RSS 367.8 → 302.3 MB
> (DOWN, then flat); heartbeat latency flat (median 2016ms); 0 compactions.**
> The **#112/#117-class deadlock did not reproduce**: a deliberate 120s stall
> blocked 359,003 bytes behind us and they arrived intact, and a message written
> to the BLOCKED CLI was queued not lost.
> **This was the gate that could have stopped the migration. It did not** —
> E18-01…E18-08b shipped against this evidence.
> **Three findings that changed code the same day:** `system:init` is once per
> TURN (26 for 25 turns); **`init` arrives ~10-20ms AFTER our own send and the
> CLI emits NOTHING at spawn** (which decided #135's readiness design); and
> **`system:thinking_tokens` appeared — a type S-10 never saw** — absorbed with
> no transition because the mapper lists what it knows rather than defaulting.
> **The number the product must live with: ~300 MB per session × 3 processes,
> so 8 sessions ≈ 2.4 GB of CLI.** #111 inherits it.
> **What it does NOT say:** nothing about concurrency (one session), compaction
> (zero occurred), or the CHOOSERS. **Probes 2-6 remain unstarted, and they are
> what gates E18-11…E18-16 and the terminal's fate.**
**🎉 THE EPIC'S PURPOSE IS DEMONSTRATED END TO END:** a `.claude/` permission is
raised by the CLI, answered ONCE in switchboard, and **the file is written** —
in the real app, in an e2e that runs on every commit.
**E18 is 7 of 11 done, ALL MERGED with 5 CI jobs green:** #131 → PR #141 ·
#132 → PR #142 · #133 → PR #143 · #134 → PR #144 · #135 → PR #146 · #136 →
PR #147 · **#137 → PR #148 (the item the epic exists for)**.
**#138 WAS SPLIT 2026-08-01 (Dan's call) because it had become an L** —
`00-process.md` says an L is split before work starts. **#138 is now E18-08a**
(back half: the real adapter's stream recipe, `StreamService` finally
constructed in `index.ts`, `--replay-user-messages`, proven by an e2e turn
against the #134 fake — no UI). **NEW #149 is E18-08b** (front half: the
per-session flag, the honest Terminal tab, refusing a live switch, and the
**first `docs/manual/` page this epic owes**).
It grew that way for reasons worth naming: it absorbed the e2e-drives-a-turn
criterion from #134, `--replay-user-messages` from #136, a **planning gap
nobody owned** (the real adapter's stream recipe), and the fact that
**`StreamService` is still not constructed anywhere** — every item so far has
driven it from tests.
**⚠ FLAKE CLASS, recorded on #145 (2026-08-01): three load-sensitive test
failures in one day, three platforms, three unrelated specs** — macOS
`discovery-scheduler` (FIXED in #143), ubuntu `slash-commands` (open), Windows
`popout-geometry` (passes in isolation). Same defect shape every time: **a fixed
sleep standing in for "wait until the thing actually happened."** Correlates
with the suite getting heavier — E18 has added ~57 unit tests including 12
concurrent child processes. Worth one sweep, not three chases, and worth doing
before the suite grows further.
**E18 so far, ALL MERGED with 5 CI jobs green: #131 → PR #141 · #132 → PR #142 ·
#133 → PR #143 · #134 → PR #144.** Four of the ten filed spine items done.
**NEW ISSUE #145 (filed 2026-08-01): a flaky e2e**, `slash-commands.spec.ts`
second-popup-open, ubuntu under load. Failed twice during #144's CI, passed all
5 on a plain re-run with no code change — **non-deterministic, not a
regression**. Filed rather than fixed inside #134 (out of scope). The diagnosis
is in the issue, including why the test cannot currently distinguish "popup
never opened" from "scan returned nothing".
**Dan changed the working mode 2026-08-01:** he authorised **merge-and-continue
through the E18 spine** — I squash-merge each E18 PR on green CI and roll into
the next item, rather than stopping at the two gates. Applies to **#132–#140**;
genuine blockers and decisions that are his still stop the run. *(Recorded here
because it overrides `00-process.md`'s "Dan reviews and squash-merges" for this
epic only.)*
**Next up: #135 (P2-E18-05)** — session status and lifecycle from the stream.
Also still running: the **S-11 probe**, a background measurement, not a work
item.
The E18 queue is **#131–#140**, scoped and filed by `/pm` on 2026-08-01. See the
START HERE block immediately below.
**Also newly open and unscheduled: #129** (a transcript-discovery session that
has GIVEN UP still full-scans the root for ever — filed 2026-08-01 off #108's
work). Unrelated to the transport; takeable any time; not blocking anything.

> # ▶▶ START HERE — THE MIGRATION IS **SCOPED AND FILED**. NEXT ITEM IS **#131**.
> ## Dan's instruction, 2026-08-01, verbatim in spirit: *"Next, I want to work on the migration. Before we do anything else, I want to get this done now."*
>
> ### What to say in a fresh session, after `/startup`:
>
> > **`/next-item 131`**
>
> **Say the number.** A bare `/next-item` resolves the lowest-numbered open issue
> in the milestone and would pick **#90**, then **#109** — neither is the
> migration. The E18 issues are #131–#140, filed LAST, so they never win by
> number and must always be named explicitly until the older ones are closed.
>
> ### `/pm` RAN 2026-08-01 — here is what it decided
> **Dan's open question (d) is ANSWERED: it is a NEW EPIC, E18** — not a
> re-scoped E11. The one thread tying them together was cut by S-09 (permission
> delegation rides the stream-json control channel, **not** MCP, so E11's
> deferred `mcp` capability is no longer its first customer). E11 stays a
> separate epic about sessions talking to *each other*.
>
> - **Plan:** `docs/plans/05-transport-migration.md` — its own file, 16 items,
>   with the full rationale, the two S-11 facts every item must respect, and the
>   S-11 gate structure. `04-phase-2-switchboard.md` has a pointer.
> - **FILED (10 issues, #131–#140):** E18-01 DESIGN.md amendment → 02 transport
>   seam → 03 StreamService → 04 **the stream-json fake** → 05 lifecycle from the
>   stream → 06 prompt submission → 07 **`can_use_tool` → the approval bar** →
>   08 per-session flag (**the first dogfoodable point**) → 09 slash commands
>   from `system:init` → 10 Feed from typed messages.
> - **NOT FILED, on purpose:** E18-11…E18-16 (choosers, interrupt, sidechains,
>   transport-matrix e2e, hook-listener retirement, cutover). Their done-when
>   depends on S-11 probes 2–6, which are unstarted. **File them when S-11's
>   findings note lands** — do not write acceptance criteria against guesses.
>
> **Two things baked into the issues as testable constraints, so they cannot be
> forgotten:** `system:init` fires **once per turn** (#135 and #139 each pin it
> with a named test), and **`windowsHide` on every Windows spawn** (#133) — the
> bug that flashed a console on Dan's desktop 96 times during S-11.
>
> **#131 is docs-only and deliberately first.** DESIGN.md still describes a PTY
> substrate in ~30 places while PHILOSOPHY P7 was amended 2026-07-31. Amend it
> before code, the same way P7 was amended — deliberately, not eroded in a PR.
>
> ### ⚠ Dan was confused on 2026-08-01 and the confusion is worth pre-empting
> He believed the migration had already shipped, because a `.claude/` write still
> sends him to the Terminal. **It had not, and that message is correct behaviour
> from the STOPGAP, not a symptom of the migration.** Confirmed by code the same
> day: `src/main/pty/pty-service.ts` is still the only transport, there is **no
> `StreamService`**, and the string `stream-json` appears **nowhere in `src/`** —
> only in `spike/`. S-09/S-10/S-11 are throwaway probe scripts under `spike/`,
> never wired into the app. **Zero application code has moved.**
> If he asks again: after the migration that specific case DOES change — S-10
> probe B answered the identical `.claude/` write over `can_use_tool` and the
> file was written with no second prompt. It needs the transport swapped first.
>
> ### What is already settled, so `/pm` does not re-open it
> - **WHETHER: decided.** Do not re-litigate. PHILOSOPHY P7 amended §6
>   2026-07-31 to permit it.
> - **VIABLE: measured.** S-10, against Dan's own PATH CLI on his subscription.
> - **SEQUENCING: known.** `StreamService` lands BESIDE `PtyService` behind a
>   per-session flag; feed, transcript stack, state machine and the
>   extensibility registry all survive the cut. The VS Code extension keeps both
>   modes itself (`claudeCode.useTerminal`), which is the precedent.
> - **BLAST RADIUS: counted.** 14 load-bearing files; `composer.ts` deleted
>   outright. Table in the S-10 note.
> - **THE PRECONDITION NOBODY HAS BUILT:** `providers/fake.ts` spawns the OS
>   shell in a REAL PTY, and all 98 e2e tests plus the entire
>   CI-safe-without-a-login property rest on it. **A stream-json fake that
>   answers control requests is a PRECONDITION for testing stream mode, not a
>   follow-on.** This is missing from S-10's blast-radius table — add it.
>
> ### What is NOT settled — the six unmeasured items = S-11
> Probe 1 (long-run stability) is **RUNNING or DONE** — see the S-11 block below
> for its verdicts. The rest are unstarted: plan mode + `ExitPlanMode`, then
> `AskUserQuestion` (**these two are the CHOOSERS, and they decide whether the
> terminal stays as an escape hatch**), then sidechains from
> `parent_tool_use_id`, `interrupt` semantics, and the `/resume` · `/rewind` ·
> `--from-pr` pickers.
>
> **Do NOT re-run the S-09/S-10 probes** — they spend real subscription tokens
> and their outputs are transcribed in the findings notes.
> **If a CLI contract is unclear, read `docs/reference-implementations.md`
> BEFORE guessing** — now also a standing rule in `.claude/CLAUDE.md`.
>
> ---
>
> ### Background: how the decision was reached
>
> **The decision is made.** Dan, after the double-prompt failure below: *"I think
> we're going to have to just move to do it the way VS Code does it so we don't
> have this issue."*
>
> **S-11 did NOT go away; it changed job.** It was a gate on deciding; it is now
> the first phase of building, because discovering a pipe deadlocks at hour three
> is cheap now and brutal after fourteen files have been rewritten. Same probes,
> same order.
>
> S-11 is a spike → `spike/s11/` + a findings note; it is not filed and never
> will be.
>
> **The stopgap Dan approved is DONE — #127 MERGED 2026-08-01 as PR #128**,
> all 5 CI jobs green.
> `shouldHoldPermission` now declines edit-family writes into `<cwd>/.claude/`,
> so the double prompt becomes one. Deleted by the migration; kept because the
> migration is months away and this bites every skill-file edit.
> **Behaviour note for the hand-off:** the remaining prompt now arrives ~6s
> LATER than the old one did. Previously we held instantly; now the PreToolUse
> passes, the session goes `working`, and `needs-permission` only lands on the
> CLI's debounced Notification. That gap is inherent, not a hang.
>
> ### S-11 PROBE 1 IS RUNNING (RESTARTED 2026-08-01 14:39, 8h, detached — ends ~22:39)
> `spike/s11/`. `node spike/s11/status.cjs` reads it at any time;
> `node spike/s11/stop.cjs` asks it to stop (sentinel file, ~5s). **Kill it any
> way you like** — `longrun-summary.json` recomputes its verdicts on every
> periodic write, so the file on disk is complete at all times. Artifacts:
> `spike/findings/artifacts/s11/` (deliberately UNCOMMITTED while the run is
> live; they get committed with the findings note when it ends).
> **The findings note is not written yet.**
>
> **It was restarted because the first run had three bugs, all surfaced by Dan
> asking "is this what keeps popping up a blue window?":**
> 1. **`windowsHide` was set on the interesting spawn and missed on the boring
>    one.** The 5-minutely PowerShell call that sums the CLI's RSS flashed a
>    console on his desktop — 96 times over an 8h run. *Every* spawn on Windows
>    needs it.
> 2. **The clean stop never worked on Windows and silently threw away 85 minutes
>    of verdicts.** They were computed in a `SIGTERM` handler — a POSIX habit;
>    `process.kill(pid,'SIGTERM')` maps to `TerminateProcess` here and the
>    handler never runs. The README confidently documented the opposite. Fixed
>    by making the summary complete at all times rather than at exit.
> 3. `stop.cjs` refused to act with no pid file, though a probe started any
>    other way is very much alive.
>
> The 85-minute partial run is archived at
> `spike/findings/artifacts/s11/partial-80m/` (raw data intact, no verdicts
> block — it can be recomputed offline if ever needed).
>
> **Q1 (backpressure) IS ALREADY ANSWERED, from a 7-minute validation run:**
> we stopped draining stdout for 150s mid-turn; **358,556 bytes piled up behind
> us and then arrived intact — 0 parse failures, the turn completed with its
> full 35,527-token output, and the process never died.** The CLI blocks on a
> full pipe and recovers; it does not wedge and does not corrupt framing.
> **A message written to the CLI *while it was blocked* was queued, not lost.**
> ⇒ **The #112/#117-class deadlock we were most afraid of did not reproduce.**
>
> **⚠ THE FIRST SMOKE RUN REPORTED `RECOVERED` AND HAD PROVED NOTHING.** A
> 5k-token answer is only ~90 KB of stdout, and Node's 64 KB
> `readableHighWaterMark` plus the OS pipe buffer swallowed all of it — the CLI
> was never blocked, so pausing our reader tested nothing. The probe now
> measures the bytes actually waiting at resume and reports **INCONCLUSIVE**
> below 150 KB. *Same lesson as #107's test-that-could-not-fail: it is worse
> than no test, because it gets counted.* Any future probe of this shape must
> state how it filled the buffer.
>
> **Two incidental findings already worth carrying into the migration:**
> - **`system:init` is emitted ONCE PER TURN, not once per session** (4 turns →
>   4 `system:init`). A host that treats `init` as a one-time event — and that
>   is exactly how one would naively consume it for `slash_commands` — will
>   re-initialise on every turn.
> - **Child RSS is ~380 MB for ONE idle-ish session** (3 processes: cmd.exe →
>   claude.cmd → node). The product is 8 concurrent sessions, so that is
>   ~3 GB of CLI before switchboard's own footprint. Not a blocker, but it is a
>   number nobody had, and it belongs in the migration's cost column.
>
> Still open in probe 1, answered only by the long run: Q2 survival across
> hours + the `keep_alive` cadence (**0 keep_alives in 7 minutes**), Q3 memory
> and latency drift, Q4 context cost (**cacheRead grew 25,951 → 72,763 over
> 3 turns**; `input` stays at 2 and would lie if read alone).

> ### S-11 — the six unmeasured stream-json items, REORDERED
> Source: `spike/findings/s-10-stream-json-transport.md` §3. The order there is
> not the order to run them in.
> 1. **Long-run stability FIRST, started immediately and left running.** S-10
>    lists it sixth; every probe so far was a SINGLE TURN, and the actual product
>    is 8 sessions on open pipes for 8 hours. A PTY is a well-understood
>    long-lived object; an NDJSON pipe with a control channel and `keep_alive` is
>    not, and unhandled stdout backpressure deadlocks a busy session — the
>    #112/#117 class of bug, which cost weeks each. **If this is bad, nothing
>    else matters.**
> 2. **Plan mode + `ExitPlanMode`**, then **`AskUserQuestion`**. These are the
>    CHOOSERS, and per S-10 §5 the choosers are what decide whether the terminal
>    stays as an escape hatch. Everything else is detail by comparison.
> 3. Then sidechains from `parent_tool_use_id`, `interrupt` semantics, and the
>    `/resume` · `/rewind` · `--from-pr` pickers.
>
> **Known gap in S-10's blast-radius table, add it:** `providers/fake.ts` spawns
> the OS shell **in a real PTY**, and all 98 e2e tests plus the entire
> CI-safe-without-a-login property rest on it. Stream mode has no fake at all —
> one that speaks stream-json NDJSON and answers control requests is a
> **precondition** for testing stream mode, not a follow-on.
>
> **Do NOT re-run the S-09/S-10 probes** — they spend real subscription tokens
> and their outputs are transcribed in the findings notes.
> **If a CLI contract is unclear, read `docs/reference-implementations.md`
> before guessing.**
>
> ### Consequence already recorded: **#111 is questionable**
> Its premise is "measure the shape we are keeping", and we do not yet know if
> PTY concurrency is that shape. Park it behind S-11 rather than spend it
> measuring something we may migrate off.

**#125 MERGED 2026-08-01 as PR #126**,
all 5 CI jobs green. Gate: lint + typecheck + **621 unit (+9) + 98 e2e
(+1)**, 1 skipped. **One review round, 1 blocker + 8 should-fixes, all taken.**
The blocker was mine and was a *regression in the very thing the item exists to
fix*: I used the `-ink` token on a hue-tinted background, and on nordic — the
default theme — ink IS the hue, so the bar's own prose measured **3.89:1**,
worse than the chip it replaced (which used `--text`). Colour now lives in the
border and the tint; the words are `--text` at 8:1.
**Next: S-11 + #108 in parallel — see the START HERE block at the top.**
Before it: **#107 (P2-E15-10) MERGED 2026-07-31 as
PR #124**, all 5 CI jobs green. Gate: lint + typecheck +
**612 unit (+43) + 97 e2e (+4)**, 1 skipped; `npm run check:transcripts` run
against the real CLI 2.1.220 — bound, and **no drift**. **Two review rounds, 3
blockers + 14 should-fixes, all taken**, and the first blocker rewrote the
design: evidence that a conversation started may NOT be hook traffic, because
`SessionStart` fires at spawn and carries a session id, so the first version
turned every un-prompted card red 45s after it opened. Six revert-proofs, each
re-run.
> ## ✅ [user] TESTING DONE 2026-08-01 — 9 of 10 pass, one real defect found
>
> **#124's six: ALL PASS.** *(Recording an error of mine: Dan had already run
> these and said so; I logged them as outstanding anyway and he re-ran them.
> Don't repeat that — when he says a list passed, it passed.)*
> **#126's ②③④: PASS** — contrast good in both themes, **no post-Allow flash**
> (the 2s `recentlyDecided` window is correctly sized), banner/scroll unaffected.
>
> ### ❌ #126 ① FAILED — and the failure is the most important finding to date
>
> Editing a file in a project's own `.claude` folder prompts Dan **TWICE**:
> first our approval bar, then — after he allows it — the CLI's own terminal
> prompt. **Confirmed in the log, not inferred:**
> ```
> 10:28:22  permission held   tool: Write        → needs-permission (permission-held)
> 10:29:19  permission decided: allow            → we answered the CLI "allow"
> 10:29:25  needs-permission  cause: hook:Notification   ← it asks AGAIN, 6s later
> ```
> **Mechanism:** our hook returns `permissionDecision:"allow"`; the CLI honours
> that for the ordinary permission layer, then applies its `.claude/` safety
> check ON TOP, and **a hook's allow does not satisfy it.** We ask, he answers,
> the answer is discarded.
>
> **Contrast with S-10 probe B**, where the identical write arrived over
> stream-json as `can_use_tool` with `decision_reason_type:"safetyCheck"`, we
> answered allow, **and the file was written — no second prompt.**
>
> ⇒ **The same verdict is worth LESS from a hook than from the permission-prompt
> channel. Our approval path is structurally second-class.** This was not known
> from S-09 or S-10 — both probed the stream path or print mode, never the
> hook path against a `.claude/` write in the real app. It is the strongest
> single argument for the migration.

> ## 🟠 DECIDED, NOT BUILT (2026-07-31) — permission prompts switchboard cannot see
>
> **Dan hit a real bug mid-session; it opened a foundational question, and the
> answer changed the constitution. Read this before picking up any E10/E11 work,
> and before touching anything PTY-shaped.**
>
> **One-line state:** the bug is understood, the terminal-preserving fix is
> proven impossible (S-09), the workaround failed, the stream-json route is
> proven viable on our own CLI (S-10), P7 is amended — and **no code has moved
> and no issue is filed.**
>
> **Symptom:** ClaudeMon asked to create `.claude\scripts\coverage.sh`. The
> rail and Events showed *needs-permission*; the Session view showed no approval
> bar and no way to answer; the Terminal showed the CLI's own prompt.
>
> **Diagnosed from the live log + the shipped session settings — all confirmed,
> none inferred:**
> 1. Allow-all was enabled on that session at 00:19:45.
> 2. The status came from `hook:Notification`, **not** `permission-held` — so
>    nothing was ever held, `approval` was null, and the missing bar is correct
>    by construction.
> 3. The session's shipped `PreToolUse` matcher **does** include `Write`, and the
>    card is on `ask`, which gates `Write`. So a PreToolUse never reached us.
> 4. **ClaudeMon's project `.claude/settings.json` already allows bare `Write`
>    and `Edit`** — and it still prompted.
>
> ⇒ **Claude Code guards `.claude/` writes ABOVE both the permissions layer and
> the hooks layer.** Deliberate on their part: the rules live *in* `.claude/`, so
> a rule there granting write access to `.claude/` would be privilege escalation
> (and would let a repo disable our own hook config). We should not route around
> it.
>
> **But the VS Code extension DOES surface these prompts** (Dan's counter-example,
> and he was right). Mechanism found in the shipped extension bundle
> (`~/.vscode/extensions/anthropic.claude-code-2.1.220-win32-x64/extension.js`):
> the CLI delegates via a `can_use_tool` control request whose payload carries
> `blocked_path`, `decision_reason`, `title`, `display_name` and
> `permission_suggestions` — i.e. **the CLI is built to hand this exact prompt to
> a host UI.** The extension gets it by passing `--permission-prompt-tool stdio`
> **and driving the CLI with `--output-format stream-json --input-format
> stream-json` — it hosts NO terminal and renders everything itself.** That is the
> opposite architectural choice from ours.
>
> **The lever was tested and it is CLOSED — spike S-09, 2026-07-31**
> (`spike/findings/s-09-permission-prompt-tool.md`, `spike/s09/`).
> `--permission-prompt-tool <mcp-tool>` is honoured under `--print` — the
> control run caught the *exact* `.claude/scripts/coverage.sh` write and allowed
> it — and is **SILENTLY IGNORED by an interactive TUI session**: MCP server
> connected, `initialize` + `tools/list` served, `tools/call` never sent, CLI drew
> its own prompt. **There is no flag that gives switchboard the permission prompt
> while it hosts a TUI. The cheap win does not exist.**
> Two useful by-products: the `.claude/` guard **is** delegatable in principle
> (so it is not special-cased against us — we are simply not on the receiving
> end), and **MCP works fine interactively**, which matters for E11's Session Bus
> even though permission delegation does not ride it.
> *Read the findings note's "four false negatives" section before running any
> spike of this shape — a .cmd shim, inherited `CLAUDE_CODE_*` env, a
> bracket-pasted single-line prompt and a trust dialog each produced a result
> indistinguishable from "the flag does nothing".*
>
> **Why it matters beyond the annoyance:** our entire approval path rides on
> PreToolUse hooks, which is a workaround — blind to anything the CLI decides
> above the hook layer (this bug), and needing the hold-and-release dance.
> `--permission-prompt-tool` is the sanctioned mechanism, and it would be the
> first real customer for the `mcp` capability deferred to **E11**.
>
> **Dan's position, recorded verbatim in spirit:** he does not personally care
> about having the terminal and would rather the session window worked like the
> extension's. **That is a PHILOSOPHY-level change** — "host-don't-reimplement
> (real CLI in real terminals)" is one of four hard constraints — so it gets
> amended deliberately and first, not eroded in a PR.
> **STATUS (updated 2026-07-31, later): DECIDED IN PRINCIPLE — the stream-json
> transport is the route. P7 has been amended. The migration is NOT started and
> NOT filed.**
>
> Two things closed the question after S-09:
> 1. **The workaround failed.** The option-1/3 workaround for `.claude/` writes
>    was attempted in a parallel session and did not work (Dan, 2026-07-31 — that
>    session holds the specifics). The cheap path is not available, not merely
>    unsatisfying.
> 2. **The precondition got measured — spike S-10**
>    (`spike/findings/s-10-stream-json-transport.md`, `spike/s10/`). Against
>    **our own PATH CLI**, not the extension's bundled copy:
>    - Duplex stream-json runs **without `--print`** (the `--help` text saying
>      otherwise is stale), streams token deltas, and stays alive between turns.
>    - `--permission-prompt-tool stdio` delivered **the exact
>      `.claude/scripts/coverage.sh` case** as a `can_use_tool` control request
>      carrying `decision_reason`, `decision_reason_type: safetyCheck` and
>      `permission_suggestions`. Answered allow; the file was written.
>    - **Subscription auth is fine** (`rate_limit_event` reports the same
>      five-hour/weekly windows; no API key anywhere).
>    - **The JSONL transcript is still written** — so `watcher.ts` / `drift.ts` /
>      binding **survive the migration** rather than needing replacement in the
>      same step. (The stream also carries `transcript_mirror`, so they become
>      redundant later, on their own schedule.)
>    - **Slash commands work as plain user text**, and `system:init` advertises
>      `slash_commands` live — 59 entries including this machine's *project and
>      user* commands, which replaces the 40-entry hand-curated list in
>      `providers/claude.ts` with ground truth.
>    - **No trust dialog** is drawn in this mode.
>
> **The VS Code extension uses NO PTY at all** — plain `child_process.spawn` with
> pipes; `node-pty` does not appear in its bundle. It also **keeps a terminal
> mode as an escape hatch** (`claudeCode.useTerminal`, default false), which is
> the precedent for our own sequencing. Full mechanism in the S-10 note.
>
> **PHILOSOPHY P7 AMENDED 2026-07-31** — see the new **PHILOSOPHY §6 Amendments**.
> Fidelity to the CLI's behavior is the invariant; the terminal was one transport
> for it. New hard line added: *a decision the CLI delegates we may present; a
> decision the CLI keeps we may never fake* — which kills S-09's option 3
> (screen-scraping) on principle, now recorded as a §5 precedent. The amendment
> explicitly does **not** decide that the terminal goes away; that is an
> engineering call still bound by litmus 3 and 4.
> `README.md` and `.claude/CLAUDE.md` restatements updated to match.
>
> **STILL UNMEASURED — do not treat as answered** (S-10 §3): plan mode +
> `ExitPlanMode`, `AskUserQuestion`, sidechain/subagent rendering from
> `parent_tool_use_id`, the `/resume` `/rewind` `--from-pr` pickers, `interrupt`
> semantics, and **long-run stability** (every probe was a single turn). The ones
> that turn out to be choosers are what decides whether the terminal stays as an
> escape hatch.
>
> **Blast radius, counted:** 14 load-bearing files (68 mention `pty`; the rest
> are comments and tests). `composer.ts` is deleted outright — the bracketed
> paste and the 75 ms delayed CR become one `stdin.write`. Feed, transcript
> stack, state machine and the extensibility registry all survive. Table in the
> S-10 note.
>
> **When stuck on a CLI contract during this work: `docs/reference-implementations.md`.**
> The VS Code extension is unpacked on this machine and is a known-correct
> consumer of every contract the migration touches — the embedded Agent SDK and
> its arg builder, the stream-json protocol, and the full `settings.json` schema.
> That doc has the navigation recipes for the minified bundle and the rules
> (read contracts, don't copy code; verify against the PATH CLI before building).
>
> **NEXT: ~~nothing is filed~~ — SUPERSEDED 2026-08-01.** `/pm` ran, Dan chose
> **new epic E18** with its own plan file, and **#131–#140 are filed**. See the
> START HERE block at the top of this file for the queue and for what was
> deliberately left unfiled behind S-11.
>
> **The fallback is FIXED — #125, MERGED 2026-08-01 as PR #126.** When the
> CLI keeps a decision, the Session tab now shows a full-width bar docked above
> the composer, where every permission Dan has ever answered appeared, instead
> of the 10px header chip nobody saw. Under amended P7 this is not a
> consolation prize — it is the constitution's *prescribed* behaviour for a
> decision the CLI keeps, and it stays correct after any transport migration.
Before it: **#102 (P2-E15-05) + #103 (P2-E15-06) MERGED 2026-07-31 as PR #123**,
all 5 CI jobs green (windows/ubuntu/macos unit + e2e windows/ubuntu). Gate was
lint + typecheck + 569 unit + 94 e2e. **Dan hand-tested the
whole thing as it was built and signed off**; the PR's checklist is the same
list, kept for the record rather than as outstanding work. **Four themes ship,
not three:** Dan asked for a
softer high-contrast after trying it, and `soft-contrast` cost one JSON file +
one list entry + one string, no code path — the item's own claim, cashed by
someone who did not know they were testing it. **Also rides along: the session
group frame's missing RIGHT border** (Dan spotted it 2026-07-31), which turned
out to be **TWO causes**: (1) dockview sizes a group flush to a clipping
ancestor and on a scaled display a 1px border snaps to one device pixel the clip
rounds away; (2) the **sash** — 4px, `z-index: 99`, painted `var(--bg)` by #84
back when groups had no frame — covered the border on BOTH sides of a split.
Both fixed in `dockview-tokens.css`. **New `e2e/split.spec.ts`** restores a
two-group layout (the single-group suite could see neither cause) and READS
PIXELS via a new dependency-free PNG decoder in `e2e/fixtures/png.ts` — because
computed styles, geometry and `elementFromPoint` all said "fine" while Dan
looked at black. Both fixes revert-proofed. **#103 was folded in 2026-07-31 because Dan's hand-off
test 5 failed**: the theme picker worked and the choice vanished on relaunch.
Reproduced and MEASURED — the built app's origin is a random loopback port
(`:58814` then `:57029`), so localStorage is a new store every launch. Theme and
language now live in the `ui` blob. **That closes AR-P0-3 entirely.** Before it: #98 (P2-E15-01) **MERGED 2026-07-30 as
PR #122**, all 5 CI jobs green. Session creation ASKS the adapter now, so
**AR-P0-1 is CLOSED** — the last of the three P0s. Shipped FOUR capabilities —
transcripts / hooks / resume / **trust** — with **mcp deferred to E11**; the log
entry has why the shape differs from §5.3 and the two defects found on the way
(a session could adopt an OLD conversation's transcript; a card whose adapter
was gone could never start again). That PR also carried Dan's docs, no code:
**DESIGN §5.31 session find + epic E17**, the §5.30 `findInPage` correction,
**auto task labels (§5.11) as P2-E7-06**, and §10 backlog moves.
**No [user] testing outstanding** — this item had none to give (internal), and
nothing else in this file is waiting on Dan.
**Note for P2-E7-06:** the `titles` capability that item adds slots straight into
`ProviderCapabilities` in `main/extensibility/contributions.ts`, and the decision
goes in `sessions/start-plan.ts` beside the other four.

Before it: #117 **MERGED 2026-07-30 as PR #121**
(all 5 CI jobs green) — the `pty:attach` subscribe race is closed. It shipped
more than the recorded fix direction: subscribe-before-invoke, *plus*
buffer-and-replay-after-snapshot (the gap chunks are newer than the snapshot),
*plus* an **epoch** on the wire, because subscribing first also lets a chunk
from the PREVIOUS attach reach the new listener — which would have traded silent
loss for duplicated output. **#111 (P2-E15-14) is UNBLOCKED**; its one recorded
prerequisite is met. That PR also carried Dan's docs, no code: **DESIGN §5.30
document viewer** + **epic E16** (4 items, `04-phase-2-switchboard.md`) +
Phase-3 viewer-v2 note + §10 backlog moves. **E16 is planned but NOT filed as
issues** — that needs `/pm` and Dan's go-ahead.
**#117's hand-off list was run by Dan BEFORE the merge and PASSED** — all 5
(busy-tab switch, fast tab bounce, popout dock-back, TUI redraw, reveal a hidden
worker). The thing to watch was a *duplicated* block of output, the failure mode
the epoch stamp prevents; none appeared. **Nothing in this file is waiting on
Dan.**

Before it: #105 (P2-E15-08) **MERGED 2026-07-29 as
PR #120**, after Dan ran the whole hand-off test list by hand and passed it —
including the one that matters (hide a working session, reveal it, scrollback and
conversation intact). Working tree clean. *(Don't record a tip SHA here — it is
stale the moment it is committed; `git log` is the authority for that one.)*
**The queue, in order: ~~#105~~ → ~~#117~~ → ~~#98~~ → ~~#102-#103~~ → #107-#111.**
**E15 is 8 of 14 done** — #98 (provider capabilities, PR #122), #99
(process-agnostic registry), #100 (three renderer contribution points), #101
(IPC capabilities), #102+#103 (themes as data + prefs that survive relaunch,
PR #123 — two issues, one PR), #104 (renderer state layer), #105 (presentation
state, PR #120), #106 (permission hold). *(Corrected
2026-07-30: this line said "7 of 14" because it was counting #112, the tail-pin
race — that was fixed in this period but is NOT an E15 item. Neither is #117.
**Every E15 item cites an `AR-*` finding from
`docs/architecture-review-2026-07-26.md`**; if it has no AR id, it is not E15.)*
**All three P0s are now closed** — AR-P0-1 (#98), AR-P0-2, and AR-P0-3
(#102/#103: themes as token maps, and the prefs that reset on every packaged
launch — measured, not suspected). **Consumer count on the extensibility seams: 1 → 6**,
so the Phase-4 gate ("2–3 dissimilar internal consumers") is met for the first
time — a starting condition for that conversation, not a decision to ship a
plugin API.

**#108 (P2-E15-11) is DONE — MERGED 2026-08-01 as PR #130.** Dan ran its
hand-off list (all 4, including the same-folder pair) and passed it.
**Next is NOT another E15 item — it is the MIGRATION.** See the START HERE
block at the top of this file. E15's remaining items (#109 header CSP, #110
workspace schema migration, #111 concurrency re-measure) are **parked behind
the migration**, not cancelled. **#111 is parked behind S-11** — see there. **DECIDED 2026-07-30 (Dan): finish E15 first, then E16.**
The fork below is therefore closed — E9 (#73 → #74 → #76 …), #90, #91, E16 and
E17 all wait until E15's remaining items are done.
**Run them in this order** (dependency-forced where noted):
~~#98~~ (PR #122) → ~~#102 → #103~~ (PR #123 — #103 was folded into #102's PR
after its live bug surfaced during hand-off testing) → **#107 → #108** (#108
depends on #107) → **#109** (header CSP) → **#110** (workspace schema migration)
→ **#111 LAST** (re-measure S-07 concurrency: it should measure the shape we are
keeping, and its one hard prerequisite — #117 — is now merged).
**Note for #107:** it gains a second real customer beyond `ai-title` — the theme
work found nothing new, but `soft-contrast`/`high-contrast` prove the token list
can drift from `tokens.css`, and `tokens.drift.test.ts` is the pattern that
detector should follow (parse the source of truth, fail on divergence).
**E16 (document viewer, DESIGN §5.30) is planned but NOT filed** — 4 items in
`04-phase-2-switchboard.md`; run `/pm` to file them when E15 closes.
**E17 (session find / Ctrl+F, DESIGN §5.31) is planned and NOT filed** (added
2026-07-30) — 3 items; file it with E16 and run it **after** E16, which builds
the find bar E17-02 reuses and supplies its fourth find provider.
**P2-E7-06 (auto task labels, DESIGN §5.11) is also planned and NOT filed**
(added 2026-07-30) — one small item that reopens the otherwise-merged E7. It
**depends on #98**, the very item in flight, since `titles` joins the §5.3
capability object that #98 builds; file it with E16 and take it first — it is
the smaller of the two and the only one that gets cheaper by riding #98's work
while that code is fresh.

**#74 (E9-05) and #76 (E9-07) are UNBLOCKED for the first time.** #105 gave them
the store-held view tab / ladder rung / dock slot, plus working hide and reveal
primitives; both issues' blocked-on-#105 comments are answered (2026-07-29).
E9-05 owns the policy from here: auto-hide / auto-collapse triggers, reveal on
attention, the presentation-policy setting, and the `collapsed` / `tabbed`
rungs — **typed and persisted by #105 but with no transitions yet, and they
render as expanded if something sets them.**

**~~The fork~~ — CLOSED 2026-07-30, Dan's call: finish E15, then E16, then the
rest.** It had been "finish E15's audit items or go back to E9 and ship
features". Recorded so it is not re-litigated: the remaining 8 are audit work
with **no user-visible change**, so the next stretch produces nothing to
eyeball — that is expected, not a stall.

*The remaining 7, with what each is (all cite `AR-*` findings from the
architecture review — that is what makes them E15):* **#102 → #103** (themes as JSON token maps; #103 is the
likely-live bug where theme + language reset on every packaged launch),
**#107** (transcript drift detector) → **#108**, **#109** (header CSP),
**#110** (workspace schema migration), **#111** (re-measure S-07 concurrency).

**#117 is DONE (PR #121, 2026-07-30)** — see the log entry for what it actually
took. Still open and NOT scheduled: **#90**, **#91**.

*Known not-closed:* AR-P1-4 is only partly retired — `switchboard:popout-added`
/ `-removed` are still a window-object bus, and `lib/drag-context.ts` still
holds module-level mutable state. Both are outside #104's done-when.

**No [user] retests are outstanding.** #117's five were run before the merge and
passed (see the header). Before them, the list carried since
2026-07-24 — test 4 (out-of-cwd read) WITHOUT allow-all + autonomy=ask ·
grid-drag between groups · switch-to-session scroll · allow-all sessions now
silent — was **run and PASSED by Dan on 2026-07-29**, alongside #105's own
hand-off list. Nothing here is waiting on him. (OQ #8 / the ClaudeMon read was
closed the same day — we are not integrating.)

**Recently merged:** 2026-07-30 — **PR #122** (#98 P2-E15-01, provider adapter
capability objects; also carried DESIGN §5.31 / epic E17 / P2-E7-06, docs only).
Before that, same day — **PR #121** (#117, the `pty:attach` subscribe
race + the epoch on the wire; also carried DESIGN §5.30 and epic E16, docs only).
Before that, 2026-07-29 — **PR #120** (#105 P2-E15-08, presentation
state into the store + hide/reveal; Dan hand-tested and merged). Before that,
2026-07-26 — **#96** (sessions-rail redesign, three
eyeball rounds, Dan signed off) and **#97** (architecture review + the E15
epic). Before those, same day: **#94** (Deny means deny), **#95** (#92
interactive-question signal), **#93** (#72 P2-E9-03 attention queue +
Ctrl+Space, plus the scroll-position fix, Events dismiss button, session-group
frames, the workflow hand-off change, and `docs/extensibility.md`). Earlier:
PR #89 (popout geometry #86), PR #88 (tab strip #84 + quit backstop #85), PR
#83 (E9-02 palette), PR #82 (E9-01).
**Why E15 ran before the rest of E9** (architecture review, 2026-07-26) — kept
because it explains the shape of the tree, but note it is now HISTORY: E9-05
(#74) and E9-07 (#76) were hard-blocked on E15-08 (#105) because presentation
state lived in `SessionCardPanel`'s `useState` and "reveal restores it to its
exact prior slot" needs state that outlives the panel. **#105 merged 2026-07-29,
so that block is gone and both issues' comments say so.** The rest of the
argument — "every other E15 item is cheap now and an audit later" — was written
while E15 blocked E9, and no longer decides anything on its own (see the fork
above).
Within-E15 dependency order, for the items that remain: #98 (adapter) is
independent; #102 → #103. **Done: #99, #100, #101, #104, #105, #106.**
*Remaining E9:* **#73 — P2-E9-04 urgency strip + delayed urgency reset**, then
#74–#80. E9 closes Phase 2 exit criterion #1. Also open, filed 2026-07-26 and
NOT yet scheduled: **#90** (no accelerator, palette included, reaches a session
terminal) and **#91** (box the tool blocks + drop the timeline dot on plain
assistant answers).
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
- ~~[user] ClaudeMon architecture read (OQ #8)~~ — **CLOSED 2026-07-29, Dan's
  call: we are not integrating ClaudeMon.** It was the last gate on Phase 3
  planning, so **Phase 3 planning is now unblocked.** Usage tracking is
  first-party and native (DESIGN §5.13); the idea is parked in DESIGN §10 with
  a reversal trigger. Still true and now homeless: `estimateCostUsd` bakes
  pricing into the renderer UI layer (AR-P2-12) and **defaults an unknown model
  to Sonnet rates** — it invents a number. Not urgent, not waiting on anything.

## Log

- 2026-08-01 — **DAN TESTED DIRECT MODE BY HAND AND FOUND FOUR BUGS IN TWENTY
  MINUTES. All fixed (#152, #155). The `.claude` double prompt is CONFIRMED
  FIXED by the person who reported it.**
  He asked for a file inside a project's `.claude/` folder in Direct mode: **one
  approval in the session window, he approved it, the file was written, no
  second terminal prompt.** That is the 31 July bug closed, verified by hand.
  Everything else in this epic was scaffolding for that sentence.
  **The four bugs, and what they have in common:**
  1. **The setting could never take effect (#153).** It applied "on next start",
     and the only route to a next start was the card's ✕ — which
     `persist.remove`s the card and the setting with it. Fixed with **Restart
     session now** in the menu (`restartSelf` already did the right thing and
     was only reachable for an already-DEAD session).
  2. **The label lied.** It showed only the CURRENT mode, and menu entries read
     as commands — so "Transport: Terminal" looked like "switch to Terminal".
     **I misread my own control while helping him test and told him he was in
     Direct when he was not.** Now `Transport: {now} — switch to {next}`.
  3. **The hand-off bar offered a terminal that does not exist**, over a dead
     [Open Terminal] button, beside a Terminal tab correctly saying there is no
     terminal. `terminalHandoff` had no notion of transport and EVERY branch
     routes to one. Compounded by the session being genuinely stuck on
     `starting` — **my #135 bug**: `transport-ready` was deferred a tick, but
     the renderer learns the session id from a much slower IPC response, so the
     only status push it would ever get was filtered out for an id nobody knew.
     **Stream readiness is immediate, and immediate is what a
     subscribe-then-push design cannot deliver.** Now synchronous.
  4. **The setting did not survive an app relaunch.** The create-time card write
     rebuilt the record field by field and dropped `transport`. Now spreads
     `prior` and overrides only what a start decides.
  Plus **#154**: **Stop did nothing** — it wrote Esc to a PTY a stream session
  does not have. Now an `interrupt` control request, shape read out of the SDK
  bundle.
  **THE PATTERN, and it is the lesson of the day: every one of these lived in
  the gap between "the parts work" and "a person can do the thing."** 800+ tests
  were green. Each test either drove the API directly or launched the app
  pre-configured. **Nothing had ever LOOKED at a running stream session.** Three
  of the five were the same shape — a PTY affordance surviving into a mode with
  no PTY (Terminal tab, hand-off bar, Stop button) — and two were the same shape
  as each other (**field-by-field copying silently dropping a new field**:
  `reason` in the approval queue, `transport` in the card write).
  **Also compounding: the FAKE ignored the requested transport**, always
  returning a stream recipe — so no test could exercise switching even in
  principle. *A fake that cannot say "no" to a request cannot test the request.*
  New e2e now walks the human path end to end: set it, restart, use it, relaunch
  the built app, and interrupt a turn.

- 2026-08-01 — **#149 (P2-E18-08b) → PR: stream mode gets a switch, an honest
  Terminal tab, and the epic's first user documentation.**
  **The blocker I filed against this item is fixed first: the fake now writes a
  JSONL transcript**, because the real CLI does (S-10) — that is precisely why
  the transcript stack survives the migration. Without it a stream session's
  Session view read "Looking for this session's transcript…" for ever. **A fake
  that is missing something the real thing does is a fake that hides a bug.**
  With it, an e2e proves the Feed renders a stream turn **through the unchanged
  transcript path** — the concrete demonstration of the claim that made this
  migration incremental rather than a rewrite.
  **The switch is per CARD, not per session**, stored beside autonomy and
  applied on the NEXT spawn. Main **REFUSES** while a session is live and the
  menu says why: a running CLI cannot change how we talk to it, and storing the
  answer anyway would leave the card disagreeing with the process actually
  running — the user would believe they had switched. Revert-proofed.
  **The Terminal tab now says there is no terminal** instead of rendering an
  empty black rectangle. That distinction is #125's lesson exactly: a surface
  that is technically correct and reads as breakage. The copy says what you
  GAIN, not only what is missing.
  **Manual page 12 written** — the first `docs/manual/` page this epic owes,
  because this is its first user-visible surface. It leads with the bug being
  fixed (the `.claude` double prompt), states plainly what you give up (Ctrl-R,
  vim mode, the `/resume` and `/rewind` pickers), and says when to leave it off.
  **Process note, twice bitten: `cat <<'EOF'` ATE MY BACKSLASHES.** Two e2e
  regexes shipped as `/[\/]/` instead of `/[\/]/`, so on Windows they never
  split a path and `.pop()` returned the whole thing — the assertion matched
  something else and let the test run before the session was ready, costing a
  confusing debug round. **Write TypeScript with Write/Edit, not heredocs.**
  Gate: lint + typecheck + **803 unit (+6)** + **103 e2e (+3)**.

- 2026-08-01 — **#138 (P2-E18-08a) → PR: a real stream session runs, and the
  double prompt is gone — proven in the app, not in a unit test.**
  Three things nobody owned until now: `providers/claude.ts` builds S-10 §1's
  flags (`--output-format stream-json --verbose --input-format stream-json
  --permission-prompt-tool stdio --replay-user-messages`) and declares
  `transport:'stream'`; **`StreamService` is finally CONSTRUCTED in
  `index.ts`** — every item before this drove it from tests and nothing in the
  app had ever made one; and `StreamPermissions` is wired to the manager's
  message fan-out.
  **`SpawnOptions.transport` is a REQUEST, not an order.** The host asks; the
  adapter answers in the recipe, because only it knows whether its CLI speaks
  the protocol. A provider that has never heard of stream-json keeps returning a
  PTY recipe and we honour it — the same degrade-gracefully posture as the §5.3
  capabilities.
  **The composer became transport-agnostic without learning about transports.**
  `submitPrompt` tries the typed-message route and FALLS BACK to the bracketed
  paste when main answers false. The renderer has no session record to consult
  and, until #149, no setting either — and when the choice becomes user-facing,
  this function does not change.
  **THE E2E CAUGHT A BUG EVERY UNIT TEST MISSED.** `SessionGrid`'s approval
  queue copies requests field by field, and I had not added `reason` — so the
  CLI's own prose reached the renderer and died one line short of the bar. The
  router's unit tests all passed; the field was simply never carried. *Copying
  field-by-field makes a NEW field a decision, which is good, and makes a
  FORGOTTEN field silent, which is the cost.* Comment added at the site.
  **Second gap, filed not absorbed (#149): the stream fake writes no JSONL
  transcript.** The real CLI does (S-10) — that is why the transcript stack
  survives the migration — so a stream session's Session view reads "Looking for
  this session's transcript…" for ever. That blocks #149's "the Feed renders a
  stream session's turn", so the fix belongs there. **This item's e2e is scoped
  around it deliberately**, asserting the turn COMPLETES via the Events panel
  rather than asserting on rendered Feed content, with a comment saying why.
  Gate: lint + typecheck + **797 unit (+9)** + **100 e2e (+2)**. Stream mode is
  env-selected (`SWITCHBOARD_TRANSPORT=stream`) — deliberately NO UI, because a
  half-wired mode with a switch on it invites being switched. The switch is
  #149.

- 2026-08-01 — **#137 (P2-E18-07) → PR: the double prompt is answered once, and
  the answer is honoured.**
  The measured bug, restated: editing a file in a project's own `.claude/`
  folder prompts Dan TWICE, because the CLI honours a hook's allow for the
  ordinary permission layer and then applies its `.claude/` safety check on top,
  which a hook verdict does not satisfy. Over `can_use_tool` the same verdict IS
  honoured (S-10 probe B). `StreamPermissions` routes it.
  **One shape, one bar.** The stream router emits the SAME `PermissionRequest`
  and the same `onPermissionRequest` / `onPermissionResolved` /
  `pendingRequests` / `decide` surface as the hook path, so `ipc.ts` wires it
  identically and the renderer cannot tell them apart. A second request type
  would have meant a second bar to keep in step with the first.
  `decidePermission` falls through hooks → stream on ONE channel and asks the
  routers who owns an id rather than testing the `stream:` prefix — a prefix
  test is a string that can go stale.
  **The best test is end-to-end in process:** the #134 fake raises the request,
  the router offers it, we answer allow, and **the file actually gets written**
  — S-10 probe B reproduced as a repeatable test rather than a spike transcript.
  Deny writes nothing.
  **A stream session's PreToolUse is now never held** (`transportFor` on the
  hook listener). Hooks are independent of the transport, so a stream session
  can still fire PreToolUse, and holding it would ask the same question twice —
  a worse version of the bug we are fixing. **UNMEASURED and flagged in the
  code: nobody has confirmed the real CLI fires PreToolUse at all under
  `--permission-prompt-tool stdio`** — S-10 never ran hooks and stream together.
  It is a guard, not a finding. Revert-proofed.
  **A closed card auto-DENIES anything outstanding** rather than dropping it: an
  unanswered control request leaves the CLI waiting for ever, and a wedged
  session is worse than a refused tool call.
  **`decision_reason` renders in the bar** — the CLI's own prose, which a hook
  payload has no equivalent of. `--text`, NOT a hue token, because the bar's
  background is already tinted and #125 measured that exact mistake at 3.89:1.
  **ANOTHER criterion of mine turned out to be blocked, and it is recorded.**
  *"At least one `permission_suggestion` offered as a real action"* needs
  `set_permission_mode`, which is **E18-12, behind the S-11 gate**. We can render
  the suggestion but not honour it, and a button that looks like it works and
  does not is worse than no button. Moved to E18-12; issue and plan updated.
  **CI caught a test bug of mine that local Windows STRUCTURALLY could not.**
  My hold-guard test found the session's hook token by regex-scraping
  `buildHookSettings()`'s JSON; `[^"]*` swallowed the backslash from an escaped
  quote, producing `/tmp/.../hook-token\` — ENOENT on **both POSIX legs**, while
  Windows passed because it matched the other alternation branch entirely. The
  listener has a public `registerSession()` that RETURNS `{ tokenPath }`, built
  with `path.join`. **Read the API; do not scrape its output.** The fix removes
  string path-manipulation altogether, so it is platform-correct by
  construction rather than by a regex I happened to get right. Same family as
  #127 — a path assumption that only one OS can disprove.
  Gate: lint + typecheck + **788 unit (+23)** + **98 e2e untouched**.

- 2026-08-01 — **#136 (P2-E18-06) → PR: a prompt becomes a struct, and a
  planning gap surfaced.**
  `composer.ts` wraps multiline text in a bracketed paste and sends the carriage
  return **75ms later**, because text+CR in one chunk registers as a paste and
  never submits (S-03, refound live 2026-07-22). On this transport that entire
  class of timing bug does not exist: `shared/stream-protocol.ts` builds the SDK
  envelope, `JSON.stringify` escapes the newline so it can never be read as a
  frame boundary, and `SessionManager.submitPrompt` writes one frame.
  **`session_id` is deliberately EMPTY** in the envelope, matching what S-10
  sent: the id belongs to the conversation the CLI is already running, and
  echoing a stale one is how a message gets attributed to a conversation that
  has since been replaced (`/clear` mints a new one — #107).
  **The turn is marked working with no round trip**, because WE started it —
  the PTY path has to wait on a `UserPromptSubmit` hook to learn the same fact.
  `submitPrompt` returns **false** on a PTY session rather than pretending: the
  bracketed-paste route is a different operation, not this one in other clothes,
  and the renderer gains that branch in #138 when it first learns which
  transport a session is on.
  **The best test closes the loop through both real halves** — our encoder and
  the #134 fake's decoder — and asserts the fake echoes back the exact text,
  backticks, newlines, leading slash and all. If either side drifted, it fails.
  **PLANNING GAP FOUND AND RECORDED: nobody owned the REAL adapter's stream
  recipe.** Every item so far drives the fake, whose `buildSpawn` needs no
  flags. A real stream session needs `providers/claude.ts` to build S-10 §1's
  four flags and declare `transport: 'stream'`, and **no issue said so**. It
  belongs to #138 (the item that makes a real stream session creatable), which
  therefore also inherits #136's `--replay-user-messages` criterion — the flag
  has nowhere to live until the recipe exists. #138 goes S -> M. Plan file and
  both issues updated; that is now TWO criteria #138 has absorbed from earlier
  items, both because I sized the earlier ones optimistically.
  Gate: lint + typecheck + **765 unit (+13)**.

- 2026-08-01 — **#135 (P2-E18-05) → PR: status from the stream — and S-11's log
  corrected an assumption before it became code.**
  In PTY mode hooks feed the state machine; in stream mode the messages do.
  `stream-status.ts` is the pure mapper, `SessionEvent` gains three kinds
  (`stream`, `prompt-sent`, `transport-ready`), and `describeCause` reports
  **`stream:`, never `hook:`** — someone reading a transition log to find where
  a status came from has to be able to tell the transports apart.
  **The design question was "what marks a freshly spawned stream session as
  ready?" and I did not guess it.** S-11's own event log
  (`artifacts/s11/longrun-events.ndjson`) answers it: `spawn` at ms=14, our
  prompt at ms=2026, **`init` at ms=2048 — 22ms AFTER the send**, and the same
  ordering on every later turn (+6ms, +11ms). **The CLI emits NOTHING at
  spawn.** So readiness cannot come from the stream at all; it comes from the
  spawn succeeding — honest for this transport specifically, because there is no
  TUI to boot and S-10 confirmed no trust dialog is drawn in this mode. Had I
  reasoned by analogy with `SessionStart`, a stream session would have sat on
  `starting` until the user typed.
  **`system:init` therefore transitions NOTHING**, which is the opposite of what
  its name invites. It arrives once per TURN, ~10-20ms after a send we made
  ourselves, so it tells us nothing we did not already know — and treating it as
  a session start re-initialises the session every turn.
  **A revert-proof taught me something about my own tests.** Mapping `init` to
  `transport-ready` fails only ONE test — the mapper's — because
  `transport-ready` only promotes out of `starting`, so the end-to-end
  three-turns test absorbs it. That is defence in depth working, but it means
  the three-turns test is NOT what guards this. A comment now says so, in the
  test, so nobody deletes the mapper test believing it is covered.
  Also pinned: an error `result` still ENDS the turn (a failed turn is finished,
  not running — the error belongs in the feed, not in a busy badge); output
  arriving revives a `done` session even with no `prompt-sent`, because S-11
  watched a message written during a 150s stall get picked up 144s after we
  resumed reading; `transport-ready` never drags a working session backwards;
  and the ready transition lands AFTER `create()` returns, so a status listener
  cannot observe a half-built record.
  **`TransportSession.onMessage` is OPTIONAL and stays that way.** The PTY has
  no typed messages and never will — the only way to get structure out of a
  terminal is to parse the CLI's own rendering, which amended P7 forbids
  outright (PHILOSOPHY §5, screen-scraping as rejected precedent). Optional says
  that; forcing PtyService to fake it would not.
  **`prompt-sent` is defined and tested here but EMITTED by #136**, which owns
  the send path. Noted rather than left as a puzzle.
  Gate: lint + typecheck + **752 unit (+24)** + **98 e2e untouched**.

- 2026-08-01 — **#134 (P2-E18-04) → PR: the stream-json fake — and a done-when
  I had to correct in public.**
  The precondition S-10's blast-radius table missed. `providers/fake.ts` hosts
  the OS shell in a real PTY and all 98 e2e tests rest on it; stream mode had no
  equivalent, so nothing about it was testable without a subscription. Now there
  are TWO fakes, one per transport, selected by distinct VALUES of
  `SWITCHBOARD_FAKE_PROVIDER` (`1` = the original PTY fake, untouched;
  `stream` = the new one) rather than two variables, so both modes cannot be on
  at once and race to register the same `claude-code` id.
  **Split into protocol + plumbing, and the reason is a testing constraint worth
  remembering: the CI unit job does not run a build.** Anything asserting on a
  compiled entry point could only ever SKIP there, and a test that silently does
  not run is worse than none (#107's lesson). So all behaviour lives in
  `fake-stream-protocol.ts` — 20 synchronous tests, no spawn — and the compiled
  program is proven over real pipes by a new **`npm run check:fake-stream`**,
  following the four existing `check:*` entries.
  **That check immediately earned its place by catching a bug the unit tests
  structurally could not.** `fake-stream-cli.ts` is a rollup ENTRY so it lands
  in `out/main/`, but `fake-stream.ts` is imported by bootstrap and rollup put it
  in `out/main/chunks/` — so `join(__dirname, 'fake-stream-cli.js')` resolved one
  directory too deep. Worse, it failed as a **15-second spawn timeout**, because
  a child that cannot resolve its script dies on stderr while we wait on stdout.
  Now it tries both candidates and **throws a named error** if neither exists: a
  wrong path must fail as a wrong path.
  **The fake reproduces the SURPRISING behaviour, not the intuitive one.**
  `system:init` is emitted once per TURN, because S-11 measured the real CLI
  doing that — a fake kinder than the real thing hides the bug it exists to
  catch, and #135/#139 each need to pin that behaviour. Every message shape is
  copied from S-10's captured payloads, including `decision_reason_type:
  "safetyCheck"` and `permission_suggestions`, which is exactly what #137
  renders.
  **DONE-WHEN CORRECTED, not silently redefined.** #134's issue claimed *"an e2e
  drives a full turn in stream mode"*. That is unmeetable by this item — a full
  turn needs session wiring (#135) and a way to CREATE a stream session from the
  UI (#138) — and it was **my planning error in `/pm`, not a shortfall in the
  work**. The criterion moved to #138; both issues carry a comment and the plan
  file records it in both places.
  Gate: lint + typecheck + **728 unit (+20)** + **98 e2e (untouched)** +
  `check:fake-stream` **14/14 PASS**, including the `.claude/scripts/coverage.sh`
  permission round trip that started this epic — raised, answered allow, file
  written, over real pipes. `references/testing.md` updated: the two fakes, and
  why the `check:*` layer exists for build-dependent proofs.

- 2026-08-01 — **#133 (P2-E18-03) → PR: StreamService — and a bug the S-10
  probes would have handed us.**
  `child_process.spawn` over pipes, NDJSON both ways, sibling to `PtyService`
  and electron-free for the same reason. Split three ways so the interesting
  part is testable without spawning: `ndjson.ts` (framing), `message-ring.ts`
  (bounded by COUNT, not bytes — "the last N messages" is what a late attacher
  needs; byte-bounding would evict a long turn and keep a hundred keep_alives),
  `stream-service.ts` (lifecycle). **43 tests, 14 of them against a REAL child**
  — `process.execPath` running a generated script, so no login and no network,
  the same property the PTY fake gives e2e.
  **The find worth carrying: the S-10 probes' read loop is subtly wrong, and
  copying it would have shipped a real bug.** They do `chunk.toString('utf8')`
  per chunk; a multi-byte character straddling a pipe read then decodes to two
  replacement characters and corrupts the whole JSON line. We use
  `stdout.setEncoding('utf8')`, which puts a StringDecoder on the stream to hold
  the partial sequence — the same job the NDJSON decoder does one level up.
  **Revert-proofed: remove `setEncoding` and 500 KB of emoji comes back
  corrupted.** Any non-ASCII output — a path, a diff of a UTF-8 file — can hit
  this. *"Read contracts, don't copy code" now has a concrete instance.*
  **`.cmd` wrapping is the transport's job, and it is NOT `shell: true`.** On
  Windows the adapter hands us `claude.cmd`; node-pty runs that directly,
  `child_process.spawn` does not. We wrap in `cmd.exe /c` explicitly, as the
  probes did (and as S-11's three-processes-per-session measurement reflects).
  `shell: true` would launch it just as well and hand command injection a
  foothold — cwd, args and the resolved CLI path are all user-influenced and a
  shell re-parses them. Pinned by a test asserting `shell` is never set.
  **`launchSpec` takes the platform as a PARAMETER** rather than reading
  `process.platform`, so both branches run on all three CI legs. Read from the
  ambient platform, the win32 cases would pass **vacuously** on ubuntu and
  macOS — #127's exact failure, applied before it could happen this time.
  **No separate `lifecycle-check` entry point, deliberately.** P1 needed one
  because node-pty is a NATIVE module that cannot load under vitest. `StreamService`
  has no native dependency, so the concurrency coverage (12 sessions, 64 KB
  each, no cross-talk, all exit) is a normal test that runs on every CI leg
  instead of a script someone has to remember to invoke.
  Four revert-proofs, each verified to have actually changed the file first:
  dropping `windowsHide` fails 2 · adding a `pause()` fails the flood test ·
  dropping the partial-line hold fails 7 (including both real-child framing
  tests) · dropping `setEncoding` fails the multi-byte test.
  *(Process note: a `perl -0pi` revert in #132 silently did not apply and
  reported a pass. Every revert-proof here asserts the edit landed before its
  result is believed.)*
  Gate: lint + typecheck + **708 unit (+43)**. No user-facing change.

- 2026-08-01 — **#132 (P2-E18-02) → PR: the transport seam. Zero behaviour
  change, and that is the deliverable.**
  `SessionManager` already took a narrow `PtyLike` (spawn/remove; pid/onExit/
  kill) from P1, so this widened an existing interface rather than inventing
  one: `PtyLike` is now an alias of `SessionTransport`, `SpawnRecipe` gained an
  optional `transport?: 'pty' | 'stream'` defaulting to `'pty'`, and the manager
  routes on it. The PTY stays a positional constructor arg and extra transports
  arrive in an optional 5th — so **every existing call site and test compiles
  unedited**, which was the acceptance criterion. 654 → 665 unit; the 11 new are
  all about routing.
  **An unimplemented transport THROWS rather than falling back to the PTY**, and
  resolves BEFORE the record is created so nothing is orphaned — the same
  contract as the "no provider adapter" throw it sits beside. A silent fallback
  would hand a stream-json adapter a terminal and surface hours later as garbled
  output or a session that never answers a permission request.
  **`buildEnv` / the S-01 landmine list moved to `transport/env.ts`** and is
  re-exported from `pty-service.ts` so the old import path still works. The
  scrub is a property of spawning a child from Electron, not of node-pty. A test
  asserts the two import paths are the SAME function object, because a copied
  second list is how "both transports behave the same" stops being true without
  anything failing.
  **Beyond the issue text, and worth the scope:** `sessions/ipc.ts` called
  `ptys.remove(liveId)` directly on card close, bypassing the seam entirely —
  for a stream session that is a no-op on a service that never had it, i.e. **a
  leaked child process nobody would notice until the count grew.** The teardown
  moved inside `SessionManager.remove()`, where the record's transport is known.
  Its doc comment had claimed it killed the process since P1 while the body did
  not; now it does.
  **The ordering inside `remove()` is load-bearing and I got its rationale wrong
  first.** The record is deleted BEFORE the teardown because a transport's
  `remove()` fires `onExit` synchronously and `apply()` drops events for
  sessions it no longer knows. My first test asserted no *exit event* — which
  fails, because the exit listeners live in the `onExit` closure and never
  consult the map, before this item as well as after. The real invariant is no
  *status transition*: swap the two lines and closing a card pushes
  `starting->done` into history and notifies every status listener about a
  session the user just closed. **The test caught my own comment being wrong,
  which is the entire argument for writing it.**
  Also caught: a revert-proof I ran via `perl -0pi` **silently did not apply**
  and reported a pass — a test that could not fail, the #107 lesson in a new
  costume. Re-run as a real edit, it fails correctly. *Scripted reverts must be
  verified to have changed the file before their result is believed.*
  Three revert-proofs, each re-run: silent fallback fails 3 tests · killing
  through the default fails the routing test · swapping the `remove()` order
  fails the transition test.

- 2026-08-01 — **#131 (P2-E18-01) → PR #141: DESIGN.md catches up with the
  constitution.** Docs-only, and first in the epic on purpose. P7 was amended
  2026-07-31 (PHILOSOPHY §6); DESIGN.md never was, and asserted the PTY as *the*
  substrate or *the* input route in ~12 places. Two documents disagreeing is how
  every E18 item ends up re-arguing the decision in review.
  §6 gains an amendment block in PHILOSOPHY's own three-part shape — changed /
  what forced it / what it costs / what it does NOT decide — so there is **one**
  place to read the argument and one place to get it wrong. Structural edits:
  `StreamService` in the §5 diagram, §5.1's spawn, §5.2 three-channels → two
  alternative transports plus the two that ride alongside either, §5.10's
  Terminal tab. Ten input-route phrase swaps.
  **§5.16 got a forward-pointer, not a rewrite** — deliberate: it describes the
  PTY transport's approval path, and E18-07 rewrites it when E18-07 *builds* it.
  Writing it now would be recording unbuilt behaviour as settled design, which is
  DESIGN drifting from reality in the other direction.
  **Self-review caught an overclaim in my own text, and it is the finding worth
  keeping.** I had written that the transport "buys" `interrupt` /
  `set_permission_mode` / `set_model` / `rewind`. S-10 §3 says the opposite —
  interrupt semantics were **never exercised**, and `rewind` exists as a control
  request while its *picker* does not. Stated my way it read as measured. Now
  split into MEASURED (`can_use_tool`, token deltas, live slash commands) vs
  present-but-unverified, with an explicit *"do not plan against them until
  E18-12 measures them."* **Same error class as the S-11 smoke run that reported
  RECOVERED having proved nothing** — a claim that is true about the protocol
  and false about our evidence. §6 also now names all six unmeasured behaviours
  as a cost of unknown size, so the amendment cannot be read as "this is free."
  **One thing beyond the approved plan, flagged not buried:** §5.16 still
  proposed a screen-scraping fallback ("detect prompt via Notification hook,
  render our diff, send keystrokes to PTY") — forbidden outright by amended P7's
  third line and recorded as rejected precedent in PHILOSOPHY §5. **Struck
  through rather than deleted**, because the rejection is the useful part.
  Gate: lint + typecheck + **654 unit**, count unchanged because no code moved.

- 2026-08-01 — **`/pm`: the stream-json migration is scoped and filed as epic
  E18 — plan `docs/plans/05-transport-migration.md`, issues #131–#140.**
  **Dan's open question (d) answered: NEW EPIC, not a re-scoped E11.** The only
  thing that ever tied them together was "permission delegation would be the
  first customer for E11's deferred `mcp` capability" — and **S-09 cut that
  thread**: delegation rides the stream-json control channel, not MCP. E11 is
  about sessions talking to *each other*; E18 is about how we talk to the CLI.
  Folding a 14-file transport rewrite into E11 would have rewritten E11's exit
  criteria to describe a different feature.
  **Its own plan file, not an appendix to `04-phase-2-switchboard.md`** — that
  file is already ~800 lines across E7–E17, and E18 carries its own exit
  criteria and its own gate structure.
  **16 items; 10 filed, 6 deliberately not.** The filed spine is exactly the set
  that is independent of how the S-11 chooser probes turn out: seam → service →
  **fake** → lifecycle → submission → **approvals** → flag → commands → feed.
  E18-11…E18-16 (plan mode/`ExitPlanMode`/`AskUserQuestion`, interrupt,
  sidechains, transport-matrix e2e, hook-listener retirement, cutover) stay
  unfiled because their done-when depends on probes 2–6, which are unstarted —
  per `00-process.md` we do not file issues whose acceptance criteria we already
  know to be unstable.
  **Three things the scoping surfaced that were not in S-10's blast-radius
  table or the earlier notes:**
  1. **DESIGN.md is a live fork and gets amended FIRST (#131, docs-only).** P7
     was amended 2026-07-31; DESIGN was not, and it still names the PTY as *the*
     input route in ~30 places (§6 stack, the architecture diagram, §5.9's
     Esc-to-PTY, §5.16's "sends keystroke to PTY"). Amend it deliberately ahead
     of code, the way P7 was — not eroded in whichever PR trips over it.
  2. **`SessionManager` already has the seam.** It takes a narrow `PtyLike`
     (spawn/remove; pid/onExit/kill) from P1, so #132 widens an existing
     interface rather than inventing one. Its acceptance criterion is therefore
     *"all existing unit + e2e tests pass **unedited**"* — **if that PR touches a
     test, the seam was wrong.**
  3. **#138 (the per-session flag) is the first dogfoodable point, and the Feed
     needs no work to get there** — the JSONL transcript is still written in
     stream mode (S-10), so the existing transcript-driven Feed renders a stream
     session as-is. #140 is a token-level-streaming *upgrade*, not a
     prerequisite. What #138 does have to handle: **stream mode has no PTY, so
     the Terminal tab must say what it is** instead of showing an empty black
     pane.
  **Two S-11 findings are baked into issue done-whens so they cannot be
  forgotten:** `system:init` is emitted **once per turn, not once per session**
  (#135 and #139 each pin it with a test named for the finding — the naive
  `slash_commands` consumer re-initialises every turn or grows the list without
  bound), and **`windowsHide` on every Windows spawn** (#133), which is the bug
  that flashed a console on Dan's desktop 96 times during the first S-11 run.
  Also recorded in the plan as the migration's cost column: **~300–380 MB child
  RSS per session × 8 sessions ≈ 2.4–3 GB of CLI**, which #111's re-measure now
  inherits as a second question.
  **Nothing was re-litigated.** The plan opens with a "what we are NOT
  re-opening" section (whether — decided; viable — measured; sequencing — known;
  the transcript stack survives) precisely so no item spends a review round
  re-deriving it.

- 2026-08-01 — **#127 MERGED as PR #128 (5 CI jobs green): never ask a
  question whose answer the CLI discards.**
  Editing a file in a project's own `.claude/` folder prompted Dan **twice** —
  our approval bar, then the CLI's own terminal prompt six seconds after he
  allowed it. **Measured, not inferred** (log at 10:28:22 / 10:29:19 / 10:29:25):
  the CLI honours a hook's `permissionDecision:"allow"` for the ordinary
  permission layer and then applies its `.claude/` safety check ON TOP, which a
  hook verdict does not satisfy. His answer was discarded.
  **This is P7, not UX.** We had now *proven* the CLI keeps that decision, so
  holding it presented a decision we do not own and taught him our approvals are
  advisory. `shouldHoldPermission` declines it; the #125 handoff bar explains
  the CLI's prompt. **The same verdict over stream-json's `can_use_tool` channel
  DOES satisfy the safety check (S-10 probe B) — a hook's word is worth less
  than the permission-prompt channel's, which is the sharpest argument yet for
  the migration and was not known from S-09 or S-10.**
  **Review caught a blocker that Windows could never have shown: the new tests
  would have FAILED on the ubuntu and macOS CI legs** — a `C:/...` literal is a
  *relative* path on POSIX, so `path.resolve` mangled it. Worse, the negative
  cases would have passed **vacuously** there (the carve-out never fires, so
  they hold even if the predicate were `() => false`) — a green half-suite
  proving nothing. The file already had the `win ? … : …` pattern for exactly
  this, twice. Now platform-shaped, and verified by simulating all nine cases
  under `path.posix` before pushing.
  Three more taken: the branch keys off `toolCategory === 'edit'` rather than
  `MUTATING` (which also holds `WebFetch` — pathless today, one schema change
  from silently un-holding a network tool); the comment's stated risk was wrong
  and now names the real load-bearing assumption (**the CLI's guard uses the
  same LEXICAL containment rule we do — neither resolves links**, so a junction
  under `.claude/` escapes both); and the **home-directory case is pinned by a
  test**, because a session running in `~` makes `<cwd>/.claude` the GLOBAL
  config — global hooks that fire in every session — which is the
  highest-consequence instance of the carve-out.
  `isOutsideCwd` and `isInsideClaudeDir` now share one `contains()`, with a
  comment recording why the resolve bases are asymmetric and why the obvious
  refactor (`!isOutsideCwd(p, join(cwd, '.claude'))`) is wrong.
  Gate: lint + typecheck + **632 unit (+11) + approval e2e green**. One
  revert-proof re-run.

- 2026-08-01 — **#125 MERGED as PR #126 (5 CI jobs green): a decision the CLI
  keeps gets a bar, not a whisper.**
  The fallback affordance was a **10px chip in the top-left header strip**, in
  the `--status-needs-input` hue, while every permission Dan had ever answered
  arrived as a full-width tinted bar docked above the composer. On 2026-07-31 he
  looked at the bottom, saw nothing, and concluded the app had lost the session.
  **The chip was rendering correctly the whole time** — which is why this was
  never a logic bug and why the fix is presentational.
  Under **P7 as amended the same day**, this is the constitution's prescribed
  behaviour, not a consolation prize: a decision the CLI *keeps* may never be
  faked (screen-scraping is rejected precedent, §5), so *"say so plainly and
  route the user to where the decision lives"* is the whole of what we are
  permitted to do — which makes doing it well the entire job. It also survives
  any transport migration: there will always be decisions the CLI keeps.
  Shape follows `binding-copy.ts` from #107 — a pure `terminal-handoff.ts`
  decides *what* to say, `TerminalHandoffBar` renders it in `ApprovalBar`'s dock.
  **Review: 1 blocker, 8 should-fixes, all taken. The blocker was mine and was a
  regression in the exact sentence the item exists to make readable.** I reached
  for the `-ink` token — the #107 round-2 lesson — but applied it over a
  *hue-tinted* background, and on **nordic, the default theme, ink IS the hue**
  (tokens.css says so in as many words). Measured: **3.89:1**, against the 4.5
  bar the drift test enforces, and *worse than the chip I replaced*, which used
  `--text`. Colour now carries the tone in the border and the tint; the words are
  `--text` at 8:1. *The lesson is narrower than "use ink": a token validated
  against one background is not validated against a tinted one.*
  Four more worth keeping. **The bar flashed a false statement after every
  Allow** — the queue pops synchronously while `permission-resolved` needs a
  full IPC round trip, so for a frame the card read "needs-permission with
  nothing held" and told the user we couldn't answer *in the spot they had just
  clicked*; a `recentlyDecided` window closes it. **The suppression predicate
  disagreed with the render predicate** (`!!approval` vs `approval && onDecide`)
  — unreachable today, but if they ever diverged the user would get neither
  surface; they are one expression now. **My new e2e's positional assertion
  could evaporate silently** — it compared against a feed element that only
  exists while the feed is EMPTY, behind a `.catch(() => null)`; it asserts
  against the composer now, unconditionally. And **the copy asserted something
  our own findings contradict** — it said the CLI "always keeps `.claude` edits
  for itself", but S-09/S-10 proved that guard *is* delegatable, just not to our
  transport. Reworded to describe what we observe rather than the CLI's nature,
  so it does not quietly become false the day a migration lands.
  Two revert-proofs, each re-run: dropping `recentlyDecided` fails the in-flight
  test; pointing a tone at a non-existent token fails the new theme-token test
  (which replaced a tautology that asserted the TypeScript union back to itself).
  Gate: lint + typecheck + **621 unit (+9) + 98 e2e (+1)**, 1 skipped.
  Docs: `03-session-view.md` + `11-troubleshooting.md` rewritten around the bar;
  **DESIGN §5.10/§5.16 and the E9 plan entry corrected in 4 places** — they still
  documented the chip as shipped.

- 2026-07-31 — **P2-E15-10 (#107) MERGED as PR #124 (5 CI jobs green): the
  transcript contract is written down, and an empty Session view stops being a
  shrug.**
  **Half 1 — the §5.26 drift detector, which had never been built.** Every
  parsed line is now walked against a DECLARED contract
  (`transcripts/schema.ts`) and a newly-seen key warns exactly once. It sits
  after the parse with no branch between it and `absorb()`: the line is
  ingested whatever it reports, which is the half of the done-when worth
  guarding — a detector that quarantines what it does not understand has traded
  a silent schema break for data loss.
  **The design changed because of a measurement.** §5.26 specifies
  re-serialize-and-diff; the corpus said don't. **250 real transcripts, 10,138
  lines: 75 distinct top-level keys, 12 line types, and we consume 7 of the
  75.** "Warn on anything we don't read" is ~50 warnings on the first session
  and a muted detector by day two. So the list is split into *read* and
  *seen-and-skipped*, and a warning now means one thing only: the CLI wrote
  something the file has not been told about. Re-serializing would also have
  reported key order and number formatting as drift. DESIGN §5.26 amended with
  an "as built" note carrying the numbers.
  **Two things the corpus could not tell us, both found in review.** It is a
  LOWER BOUND on the format — one machine's history, so `redacted_thinking`,
  `citations` and `cache_control` are absent from the measurement without being
  absent from the schema, and each would have fired a false alarm the first
  time Dan used the feature. And `summary` records were missing entirely, which
  would have made the first resume of a compacted conversation report drift —
  in a file whose neighbouring code is built around exactly that record.
  The detector is scoped **per transcripts root**: the watcher went
  provider-generic in #98 while this schema is Claude-shaped, so a process-wide
  budget would let one foreign-dialect adapter exhaust `MAX_TRACKED` and switch
  detection off for the Claude sessions too — the detector silencing itself.
  `npm run check:transcripts` prints drifted keys now; run against CLI 2.1.220
  it reports **none**, which is the schema tracking reality rather than a
  passing test we wrote ourselves.
  **Half 2 — binding transparency, and the blocker that rewrote it.** The
  Session view renders only if binding succeeds, so an empty pane meant any of
  four things. It now derives `bound` / `awaiting-prompt` / `searching` /
  `unbound` and says which — four states, not the three the issue asked for,
  because "waiting for transcript" is really two: a normal short wait, and a
  failure. Only the last is dressed as a problem.
  **Review round 1 killed the first evidence model outright.** I took "hooks
  delivered a native id" as proof a conversation had started. `SessionStart`
  fires at CLI LAUNCH and carries a session id, and the CLI does not write a
  transcript until the first prompt (our own S-07 measurement) — so the clock
  started on every card at spawn and **every card you had opened and not typed
  into would have turned red 45 seconds later**, which is precisely the false
  alarm the item exists to remove. Open five cards, work in one, and four of
  them scream. My e2e was structurally blind to it: the fake provider sends no
  hook traffic, so the suite only ever exercised the hooks-are-silent path. The
  signal is now a turn actually RUNNING (status reaching `working`), pushed in
  by `sessions/ipc.ts`, and the e2e posts a real `SessionStart` so it can fail.
  **The rule that came out of it is the load-bearing one: `unbound` always
  rests on positive evidence** — a turn that ran, or a transcript under our
  folder nobody can claim. With hooks dead and nothing on disk we cannot tell
  "not yet asked" from "written somewhere we aren't looking", and announcing a
  failure we cannot distinguish from silence is a guess in a warning's clothes.
  `awaiting-prompt` correspondingly never times out.
  **Round 2 found the same bug class twice more, one step further along.**
  `/clear` mints a brand-new conversation and writes nothing until the next
  prompt — so carrying the old turn's evidence across the reset put a cleared,
  idle session into the red. And the conversation it just abandoned sits on
  disk unclaimable for ever, which made *our own history* permanent evidence
  that our transcript was missing. Also: `candidateSeen` latched, so two cards
  in one folder marked each other during the ambiguity window (it is recomputed
  every poll now, and evidence can RETRACT); `searchingMs` kept counting up for
  the life of a healthy bound session; and the red headline used
  `--status-crashed`, which `tokens.css` says in as many words is tuned for
  dots and rings — ~3.2:1 as 11px text on daylight, below the bar the token
  drift test enforces for `--status-crashed-ink` two lines away.
  **Round 2 also caught a test of mine that could not fail.** The retraction
  guard watched the owning session first, and `poll()` iterates in insertion
  order — so the owner claimed the file before the other session ever swept,
  and the assertions passed identically against the latching implementation
  they were meant to catch. Reordered, and it now samples the transition rather
  than the endpoint. *A test that cannot fail is worse than no test, because it
  is counted.*
  **Six revert-proofs, each re-run:** restoring hook-traffic evidence fails the
  B1 test · re-latching `candidateSeen` fails the retraction test · dropping the
  abandoned-file rule fails the `/clear` test · removing the emit early-return
  turns 1 push into 7 · making the detector process-wide fails the cross-root
  test · dropping the non-object guard warns 13 times on a bare string.
  Gate: lint + typecheck + **612 unit (+43) + 97 e2e (+4)**, 1 skipped.
  Manual: `03-session-view.md` (what the three messages mean) and
  `11-troubleshooting.md` (rewritten — it had been telling users the view
  "occasionally takes a moment", which the app now says itself, and better).

- 2026-07-31 — **P2-E15-05 (#102) + P2-E15-06 (#103) → PR #123.** A theme stops
  being a two-value union — the type system literally forbade a third — and
  becomes a **base preset + token overlay** applied to `<html>`. Four themes
  ship: nordic and daylight keep their `tokens.css` blocks with EMPTY maps (they
  are what an overlay inherits, and they are the first paint, which a map
  applied by JS can never be); **high-contrast** and **soft-contrast** are JSON
  files. Themes register at a new **`theme` contribution point** — the
  registry's first DATA-ONLY point, which is the shape §5.23's tier-1 trust
  level needs; **consumer count 5 → 6**.
  **Soft contrast is the item's own claim being cashed, by someone who did not
  know he was testing it.** Dan asked for a gentler high-contrast after using
  the first one; it cost one JSON file, one list entry and one string — no code
  path, no branch, and not one test edited to accommodate it, because the value
  rules already iterate the themes as data. Both contrast themes are held to the
  SAME measured WCAG bars (body text 12.7:1 vs 21:1 — softer on purpose, both
  AAA), so "softer" cannot quietly become "worse".
  **#103 was folded in because the hand-off list failed.** Test 5 — pick a
  theme, quit, relaunch — came back daylight. Root cause MEASURED, not inferred:
  the built app is served from a random loopback port, launch 1
  `http://127.0.0.1:58814`, launch 2 `:57029`. Different origin, different
  localStorage, choice gone; the same bug ate the language setting. Both moved
  to the workspace `ui` blob with the migration `autonomy` already had, and
  `main.tsx` now awaits the blob before `initI18n()` and the first render so
  both stay synchronous at boot. **AR-P0-3 fully closed.**
  **The blocker was mine and silent:** `--group-lift: none` in the JSON made the
  rail's drop-target ring `box-shadow: 0 0 0 2px <accent>, none` — `none` is a
  whole-property keyword, not a list item, so the declaration is INVALID and
  Chromium drops all of it. The one theme whose job is visible structure lost
  its drag highlight. Fixed with a transparent shadow plus a **token `kind`**
  (`color | shadow`) that a test enforces across every built-in map. Round 2
  found the same bug class still open on the OS-change path: `followSystemTheme`
  called `applyPreference`, which WRITES, and `loadPreference` returns 'system'
  both when the user chose it and when a stored id fails to resolve — one OS
  light/dark flip would have destroyed a good preference.
  **Rider: the session group frame's missing right border — TWO bugs on one
  pixel.** (1) dockview sizes a group flush to a clipping ancestor and a 1px
  border snaps to ONE DEVICE pixel that the clip rounds away; (2) the **sash**
  (4px, `z-index: 99`) was painted `var(--bg)` by #84 back when a group had no
  frame at all, so it covered the border on BOTH sides of a split. The second
  one is why the first fix looked like it had failed.
  **The lesson worth keeping: three cheap proxies all lied.**
  `getComputedStyle` said the border existed (true), geometry said it had room
  (true), and `elementFromPoint` returns the sash even now that it is
  transparent — hit-testing is not painting. Only "is this column of pixels
  bright" matched what Dan could see, so `e2e/split.spec.ts` restores a
  two-group layout and READS PIXELS through a dependency-free PNG decoder
  (`e2e/fixtures/png.ts`). Skipped on Linux CI: xvfb runs 8-bit colour and
  quantises the anti-aliased edge.
  **Six revert-proofs, each rebuilt and re-run:** restoring `none` fails both
  new guards · removing a token fails the drift test · dropping
  `copyThemeOverlay` fails the popout e2e · localStorage persistence fails the
  relaunch e2e · repainting the sash fails the seam pixel test · reverting the
  group width fails both split assertions.
  Gate: lint + typecheck + **569 unit (+80) + 94 e2e (+8)**, 1 skipped.
  Manual: `10-settings.md` (four themes, what each is for). DESIGN §5.20 "as
  built" + §5.25 (renderer prefs never go in localStorage, with the port
  numbers); `extensibility.md` (the `theme` point, the resolved gap, the count).
  **Known and written down, not fixed:** an in-card Changes tab can keep its old
  editor skin until something re-renders it (the standalone tab is corrected on
  every switch); `--term` is a dead token — the terminal is deliberately NOT
  themed, Dan's call, the CLI owns what it prints; and high-contrast cannot
  reach the derived layer-3 tokens, so the selected-row tint and auto-group
  surface are decoration rather than signal there.

- 2026-07-30 — **P2-E15-01 (#98) MERGED as PR #122** (5 CI jobs green).
  **Session creation asks the provider instead of assuming Claude.** Four assumptions were inlined in `sessions/ipc.ts` —
  `providerId: 'claude-code'`, hook settings built unconditionally,
  `~/.claude/projects` watched unconditionally, `--resume` eligibility decided by
  calling a Claude-shaped helper. Each was invisible until adapter #2, at which
  point you would have had to edit the consumer, which is the exact failure the
  seam exists to prevent. Decisions now live in a pure `sessions/start-plan.ts`;
  an adapter declaring nothing spawns a PTY and nothing else. **AR-P0-1 closed.**
  **The contract as shipped differs from §5.3 in three ways, all deliberate, all
  recorded in DESIGN as an "as built" note.** `mcp` is NOT shipped — there is no
  Session Bus until E11, and a capability with no implementation and no consumer
  is exactly what AR-P2-13 had us delete (`event-source`). `trust` is a FOURTH
  capability the design never listed: writing Claude's `~/.claude.json`
  acceptance ran for every provider, which review correctly called a
  Claude-specific branch surviving in side-effect form. And `transcripts`
  LOCATES transcripts rather than abstracting reading them — §5.3 names a
  `TranscriptReader`, but our parser is shared by every provider writing that
  shape, and moving it behind the seam has no consumer asking for it.
  **The fake e2e adapter keeps all four on purpose** — it is a Claude stand-in,
  not the generic adapter: the harness reads the real `hook-token` files the hook
  capability causes to be written, and several specs write real transcript JSONL.
  A capability-less fake would have deleted half the harness and proved nothing.
  **Two review rounds, one blocker, twelve should-fixes, all taken.** The blocker
  was mine and data-loss-shaped: the watcher's `known` set — the thing that stops
  a fresh session adopting a conversation already on disk — was seeded ONCE from
  the constructor's root, so the moment a session brought its own root that root
  was unguarded and a brand-new card would replay an old conversation into the
  Feed and add its tokens to the usage totals. The reviewer reproduced it against
  the real class. Seeding is per-root and lazy now, and `known` is a Map keyed by
  root, because one flat set lets a second root's seed swallow the first root's
  live files whenever one nests inside the other — or is merely spelled
  differently.
  **Round 2 caught the sharper one: my own fail-open path was silent.** The plan
  collected degradations into a `warnings` array the caller drained
  immediately — but two decisions are LAZY (`buildSettings` runs inside the
  session manager, `ensureTrusted` after the caller read the plan), so an adapter
  throwing at spawn time wrote into an array nobody would read again: no hooks,
  no token, a status-blind session and zero diagnostics. It is a sink now.
  *The tests had encoded the wrong contract — they read `warnings` AFTER invoking
  the closure, which is the ordering production does not use. A test that passes
  while the caller is broken is worse than no test.*
  **Two real defects fixed on the way, neither in the issue.** A card persisted
  under an adapter that is no longer registered was permanently unstartable
  (spawn resolves the adapter and throws, and the dead id stayed persisted) — it
  now falls back to the default and heals the record. And
  `SessionManager.restart()` was deleted: a second session-start path with no
  hook settings and no `canResume` check, dead outside its own test, sitting
  right next to the thing it contradicted.
  Also: `slugForCwd`/`conversationExists` moved to `transcripts/paths.ts` so an
  adapter no longer imports the host's watcher (the dependency runs one way);
  `nativeId` is charset-checked before it is interpolated into a path (it comes
  from the store and from hook payloads, and `..` made it an existence oracle);
  the watcher refuses a non-absolute root rather than crawling from the process
  cwd, and says so against the CARD, since a warning keyed by a live session id
  is not something anyone can connect to "the Session tab is empty".
  **Revert-proofs, each re-run:** restoring constructor-only seeding fails the
  adoption test; restoring the unconditional `settingsFor`/`watch` fails the
  zero-capability test.
  Gate: lint + typecheck + **489 unit (+26) + 86 e2e** green. No manual page — no
  user-facing change. DESIGN §5.3 amended; the plan file records what shipped.

- 2026-07-30 — **New epic E17: session find (Ctrl+F), and the measurement that
  saved it from being wrong.** Dan's ask: search a session's text like a browser
  — a feature the Claude Code VS Code extension does NOT have. The obvious build
  (search the rendered blocks) **would have shipped a lie**: `BLOCK_CAP` is 1,000
  and the feed is explicitly "a view buffer, not an archive", but three real
  transcripts measured 3,356 / 2,163 / 1,363 derived blocks (1.2 MB, 744 KB,
  495 KB), so **~70% of a long session is already evicted from the renderer** and
  a DOM search would answer "no results" for strings provably in the session. So
  the engine reads the transcript FILE in main. It needs **no new capability** —
  `transcripts.read` already covers it, unlike E16's `fs.read`. Decisions: one
  Ctrl+F covers the **whole session, grouped by view** · searches **everything
  including verbosity-hidden and folded** content, jump expands · **hybrid** bar
  + results list (the list is the only way to reach evicted hits) · per-session
  now with **scope as an engine parameter**, which downgrades §10's global
  transcript search from a from-scratch item to a result surface. Two things
  recorded on the epic: `@xterm/addon-search` is **0.16.0 with no peer-dep pin**,
  so it installs against our xterm 6.0.0 but predates it (the 0.17 beta wants
  ^6.1.0-beta) — verify at runtime before building on it; and a **v1 boundary**,
  that hits in evicted blocks are readable in the list but not jump-to-able in
  place, with on-demand block loading as the named follow-up. Also **corrected
  §5.30**: I had specified `webContents.findInPage` for the viewer's Ctrl+F, which
  is right for a popped-out window and **wrong for a docked pane** — it searches
  the whole webContents, so in a four-card grid it matches the three sessions you
  are not looking at. Docked panels register a §5.31 find provider instead; the
  E17-02 test asserts it with two cards holding the same string.
- 2026-07-30 — **P2-E7-06: auto task labels, and the finding that made it
  cheap.** Dan asked whether a blank task label could auto-fill with a
  description of the session, the way the Claude Code VS Code extension fills
  its tab text. **It can, and we compute nothing:** the CLI writes
  `{"type":"ai-title","aiTitle":"…"}` into the transcript we are already tailing
  — verified against 27 real transcripts in `~/.claude/projects/`, including
  this design session's own (`"Add markdown and file preview feature"`). That
  makes it textbook P7 and **kills the old §5.11 wording**, which said the label
  would be "derived from the last user prompt, optionally LLM-compressed" — a
  model call of ours, spending Dan's subscription on chrome, to recompute
  something the CLI hands us free. §5.11 rewritten; item filed as **P2-E7-06**
  (E7 is otherwise merged, so this reopens the epic for one item; **not yet an
  issue**). Decisions: fills the **task label, never the title** (title answers
  *which project*, label answers *what it is doing* — collapsing them loses the
  first) · `labelSource: 'auto' | 'user'`, typing pins it, **clearing reverts to
  auto** (because "is it empty?" would make a deliberately blank label
  impossible) · keeps tracking while auto, **de-duped** · no title → no label,
  folder name stands. Three observed facts the implementation must respect, all
  recorded on the item: the CLI **revises** its title (`"…preview windows"` →
  `"…preview feature"`), it **re-emits every turn** (14 identical lines in a
  171-line file — undeduped that is a persist-per-turn per session), and it can
  arrive **very late** (line 8 in one transcript, lines 339 and 510 in two
  others), so the card must not reflow when it lands. `ai-title` is
  **undocumented** — a §5.26 drift item and the second real customer for #107's
  drift detector; fail-open is structural since a missing key just leaves the
  label empty. `titles` joins the §5.3 adapter capability object (E15-01) so
  non-Claude adapters get no dead code path.
- 2026-07-30 — **New epic E16: the document viewer (Dan's ask — "AIs love
  markdown and we can't read it").** Design written as **DESIGN.md §5.30**;
  epic filed in `docs/plans/04-phase-2-switchboard.md` (P2-E16-01…04, **not yet
  filed as issues** — just-in-time, `/pm` files them when the slot comes up);
  Phase-3's v2 half noted in `03-later-phases.md`. Four decisions taken up front
  so the items don't re-argue them: rendered-by-default with a source toggle
  defaulted per *file type* · **one peek slot, pin to keep** (promotes the §10
  IntelliJ preview-tab idea) · **mermaid deferred** to a code fence, with its
  ~megabyte + untrusted-SVG cost recorded in §10 · **`fs.read` scoped to open
  session folders + user-picked paths**, and deliberately NOT folded into the
  existing `fs.probe` (contents ≫ existence). Read-only is not a v1 limitation —
  it is PHILOSOPHY §5's rejected-editor precedent, so editing would need a
  philosophy amendment first. Placed in Phase 2 despite the phase being overfull
  because the cheap 80% needs **no new infrastructure**: `marked`/`dompurify` are
  already rendering assistant prose, Monaco+workers are already bundled, the
  `panel` point exists (E15-03), and own-window is E8's `addPopoutGroup`. Two
  doc inconsistencies fixed on the way past: §5.10's view-tab strip never listed
  the **Files** tab E8-05 ships as a disabled "soon", and Phase 2's exit criteria
  gained #7 (renumbering litmus to #8).
- 2026-07-30 — **DECISION (Dan): finish E15 before E16.** The remaining 8 —
  #98, #102, #103, #107, #108, #109, #110, #111 — run in that order (#103 needs
  #102, #108 needs #107, #111 goes last so it measures the shape we keep).
  Confirmed while asking the right question: **is E15 all audit work?** Yes —
  every one of the 14 items cites an `AR-*` finding from
  `docs/architecture-review-2026-07-26.md`, and nothing else in the tree does.
  **A count in this file was wrong and is fixed:** "E15 is 7 of 14 done" was
  counting #112 (the tail-pin race), which was fixed during E15 but is not an
  E15 item — neither is #117. It is **6 of 14**, and AR-P0-1 (#98) and AR-P0-3
  (#102/#103) are still open; only AR-P0-2 is fully closed.
  E16 (document viewer) is planned in the plan file but **not filed as issues** —
  that is a `/pm` step for when E15 closes.

- 2026-07-30 — **#117 MERGED as PR #121** (5 CI jobs green), and **Dan ran the
  hand-off list before the merge — all 5 passed**: busy-tab switch, fast tab
  bounce, popout dock-back, TUI redraw, reveal a hidden worker. No duplicated
  output anywhere, which is the failure mode the epoch stamp exists to prevent
  and the only new risk this change carried.

- 2026-07-30 — **#117: the `pty:attach` gap is closed, and closing it turned out
  to have a second half.** The recorded fix direction — register the renderer's
  `pty:data` listener BEFORE invoking `pty:attach` — is right but not
  sufficient on its own, and the two things it misses are both silent.
  (1) **Order.** Main takes the snapshot in the same synchronous tick it
  subscribes, so a chunk arriving during the round trip is *newer* than the
  snapshot. Writing it on arrival puts it ahead of the snapshot's content —
  xterm's write queue is FIFO and `reset()` does NOT drain it (verified in the
  shipped dist, not assumed), so the result is out-of-order, not overwritten.
  Hence buffer-then-flush-after-the-snapshot.
  (2) **Duplication.** Subscribing first also means a chunk main sent for the
  PREVIOUS attach can still be in the renderer's message queue when the next
  pane subscribes — and that one already went into the ring buffer before the
  new snapshot was taken. Replaying it duplicates output. **Arrival time cannot
  tell the two cases apart** (both land after the invoke was issued), so the
  wire carries an **epoch**: `pty:attach` → `{epoch, snapshot}`,
  `pty:data:<id>` → `{epoch, d}`, contract in `src/shared/ipc/pty.ts`. Without
  it the fix would have traded #117's silent loss for silent duplication — and
  React StrictMode makes the double-attach happen on *every* pane mount in dev.
  Sequencing lives in `renderer/src/lib/terminal-attach.ts` (pure, ported, no
  React and no xterm in its tests); `TerminalPane` just builds the ports.
  **Two review rounds, no blockers, 11 should-fixes taken.** Round 1 found the
  duplication hole above — my `ipc.ts` comment was asserting "no gap and no
  duplication" while the code could duplicate, which is the worst kind of
  comment. It also found that a synchronous throw from `attach()` would escape
  the effect AND leave a listener nothing could remove (the caller never gets a
  feed back), that `onReady` — the fit hook — sat inside the try whose catch
  tears the feed down, so a geometry hiccup could kill a healthy stream, and
  that the live write path was unguarded.
  **Round 2 found the sharpest one: my own fail-open path could reproduce
  #117.** `epoch` was assigned *after* `ports.reset()`; if reset threw, the
  catch marked the feed live with `epoch === null`, and every later chunk then
  failed the epoch test and was dropped — silently, permanently. Fixed by
  assigning before anything that can throw, and pinned by a test. Round 2 also
  argued the filter should drop only **strictly older** epochs rather than
  "not equal": a *newer* epoch means something attached after us, those bytes
  are genuinely new, and dropping them would freeze the pane. Unreachable today
  (one feed per session, one pane per session) — which is exactly why the tight
  version would fail silently the day that changes.
  **Two comment claims were factually wrong and got corrected**, both caught by
  a reviewer who checked instead of trusting: `reset()` does not drain xterm's
  write buffer (so the failure is order, not loss), and "the stale chunk is
  already in the snapshot" ignores that the 2 MB ring **evicts** — it may have
  aged out, which changes the guarantee from "no loss" to "no out-of-order".
  **Three revert-proofs, each with the test re-run:** the old
  attach-then-subscribe sequencing fails 7 of the first 10 tests; stripping both
  epoch filters fails 3; moving the `epoch` assignment back below `reset()`
  fails the blindness test.
  **No new e2e, stated plainly:** the race is load-dependent and I could not
  force it deterministically from Playwright, and a test that catches a bug half
  the time is what #112 cost us. The 23 unit tests are the deterministic gate;
  the existing suite covers the attach path end to end.
  Gate: lint + typecheck + **444 unit (+23) + 86 e2e** green. No manual page —
  defect fix, no new surface. `docs/extensibility.md` gained the payload note
  (it documents that channel); plan file records what actually shipped.

- 2026-07-29 — **#105 MERGED as PR #120**, and **the long-standing [user] retest
  list is CLOSED — Dan ran all of it and it passed**: test 4 (out-of-cwd read)
  WITHOUT allow-all + autonomy=ask · grid-drag between groups ·
  switch-to-session scroll · allow-all sessions now silent, plus #105's own
  hand-off list (the one that matters: hide a working session, reveal it,
  scrollback and conversation intact). That list had been carried in the header
  since 2026-07-24; **nothing in this file is waiting on Dan now.**

- 2026-07-29 — **P2-E15-08 (#105): presentation state has a home that outlives
  the panel.** View tab, popped-out and suspended left `SessionCardPanel`'s
  `useState` for the store, joined by §5.8's **ladder rung** and a **dock
  slot**. The split that carries the design: **view / ladder / slot persist**,
  **poppedOut / suspended are reflections** of dockview and lifecycle truth and
  are deliberately NOT written — dockview's own layout JSON already round-trips
  popout geometry, and a second copy is two authorities waiting to disagree.
  Legacy per-card `viewTab.<cardId>` keys migrate into one `presentation` blob
  and are then deleted, new home written FIRST.
  **Shipped the mechanism, not just the bag.** A state nobody writes is exactly
  what #104's review caught, and done-when 1 and 2 are untestable without a way
  to unmount a card and bring it back — so hide (palette) and reveal (click the
  session anywhere) are real, with `placeAt`/`captureSlot` pure and unit-tested.
  E9-05 keeps the POLICY (auto-hide triggers, attention reveal, the collapsed
  and tabbed rungs, which are typed and persisted but have no transitions yet).
  **`CardActions` deleted from the store** — it only registered while a card was
  LIVE, so a suspended or hidden card ignored every command; view switching goes
  straight to the store and pop-out became a module function on (api, cardId).
  **A real defect fixed in main:** `sessions:create` is now idempotent per card.
  A revealed card remounts over a session that is still running, and the old
  handler would have spawned a SECOND claude for one card. The e2e caught it,
  and the first fix was wrong in an instructive way — `exitCode` is
  `number | null`, so the `!== undefined` liveness test matched every live
  session and adopted none of them. A throwaway probe printing `sessions.list()`
  at each step is what showed it (two pids, one card).
  **Review: 1 blocker, 7 should-fixes, all taken.** The blocker was mine and
  user-visible: **a hidden card could not be closed** — the rail's ✕ routes
  through `closeCard`, which returned early when no panel existed, so clicking
  it did nothing on the one card §5.8 says still exists in the sidebar. Also
  fixed: an adopted session reported `starting` for ever (no further status push
  is coming for an idle one, so the pill lied, ⋯ controls stayed locked and the
  8s "stuck in a startup dialog" chip lit); `revealCard` checked for an existing
  panel BEFORE its await, so a double-click hit dockview's duplicate-id throw;
  the ladder could go stale on a MOUNTED card (quit between the hide write and
  dockview's microtask-buffered layout save) and nothing would ever correct it,
  which is precisely what E9-05 will read — a mounted panel now wins; the
  remembered popout rect skipped the E8-02 display check, so a card hidden on a
  monitor you later unplug would reveal off-screen; `captureSlots` ran during
  teardown, persisting index churn as the last write before exit; and the
  legacy-key migration deleted the old home before writing the new one.
  **Both fixes proved by reverting them with a rebuild in between** (the #113
  lesson): the slot test fails with `placeAt` stubbed, the close test fails with
  the hidden-card branch removed.
  Gate: lint + typecheck + **421 unit (+36) + 86 e2e (+4)** green.
  Manual: `07-workspace.md` (a new "Getting a session out of the way"),
  `06-keyboard.md` (the palette-only commands).

- 2026-07-29 — **OQ #8 CLOSED: no ClaudeMon integration. Usage is first-party
  and native.** Dan's call, and it retires the last gate on Phase 3 planning.
  The open question had been shared-library vs sidecar vs merge, unanswered
  since 2026-07-18 and flagged overdue by the architecture review.
  **A partial read of ClaudeMon's source informed the close** rather than
  deciding it: it is .NET 10, so "shared library" was never actually available
  — you cannot link .NET into an Electron main process without shipping the
  runtime, which collapses that option into "sidecar." And the engine is small:
  `JsonlUsageParser.cs` is 117 lines of JSON field access, `PricingTable.cs` is
  a dictionary plus string normalization. A sidecar would buy a .NET runtime on
  three OSes, a second CI toolchain and a second signing burden, in exchange
  for hosting work that is *read JSONL, sum integers, multiply by a table*.
  **The valuable thing in ClaudeMon is not its code — it is what it knows about
  the transcript format**, so that was extracted into DESIGN §5.13 as a
  requirement list and the source is now a reference, not a dependency: dedupe
  on `messageId:requestId` because streaming repeats the same usage across
  lines; NEVER sum `usage.iterations` on top of the totals; `<synthetic>` is
  the model on locally-injected messages; cache writes split 5m/1h at different
  rates; normalize Bedrock/Vertex/date decoration off model ids; and a numeric
  suffix means a new model VERSION at a new price, so refuse the match and show
  tokens with no cost rather than a confident wrong number.
  **That last rule is a live bug in our code.** `lib/usage.ts` regex-matches
  `/opus/i` and **defaults an unknown model to Sonnet rates** — it invents a
  dollar figure. It also has no cache-write TTL split, no id normalization and
  no dedupe key (so it will over-count the moment anything sums transcript
  lines). Recorded in `03-later-phases.md`; NOT filed as an issue, because Dan
  has not asked for usage work to be scheduled.
  Parked in DESIGN §10 as a possible future addition with a **specific reversal
  trigger**: ClaudeMon reads the OAuth credentials and calls
  `api.anthropic.com/api/oauth/usage` for **authoritative plan headroom** — on
  a subscription that is the number that matters, since you are rate-limited
  rather than billed per token. That capability, and nothing else, is what
  would justify revisiting; it carries a §5.29 credential-handling cost, which
  is why it is not free.
  Docs: DESIGN.md §5.13 (retitled "Usage & cost tracking"), OQ #8 struck
  through and closed, §8 Phase 3 roadmap line, §5.23 extension roster #2
  ("ClaudeMon usage pane" → "Usage pane"), §10 backlog entry ·
  `03-later-phases.md` (the Phase-3 planning gate removed).

- 2026-07-29 — **#117 SCHEDULED** (the `pty:attach` subscribe race). Takes the
  slot right after #105, and is now a recorded hard prerequisite for **#111**
  (P2-E15-14): not a code dependency but a **measurement-validity** one — a
  load-dependent dropped-output race would muddy exactly the concurrency
  numbers that item measures. Fix direction recorded on the issue: register the
  renderer's `pty:data` listener BEFORE invoking `pty:attach`, so the snapshot
  only ever returns to a subscriber already listening — that removes the window
  rather than narrowing it, and is the smaller of the two options in the issue
  body. Plan file carries it in the E15-14 entry and the Order section; both
  issues have comments.

- 2026-07-28 — **P2-E15-07 (#104): the renderer has a state layer.** Three
  things that were not one: module-level mutable Maps/Sets in `SessionGrid`
  (`liveToCard`, `allowAllByLive`, `dockingBackByButton`, `cardActions`,
  `tearingDown`, `restoringLayout`), a **DOM CustomEvent bus**
  (`switchboard:groups-changed` — pub/sub built out of the window object), and
  refs in `App` shadowing state so keydown handlers could read what React had
  not committed. All now one `SessionStore` (plain class +
  `useSyncExternalStore`, no new dependency).
  **The refs were RIGHT** — a keydown runs outside React's batching and two
  Ctrl+Space presses in one frame must advance two steps. The requirement did
  not go away; it belongs to a store with a synchronous `getState()` rather
  than to a pile of refs every component must remember to keep in sync. Derived
  values (rail order, queue) recompute ON MUTATION and are cached, because
  `useSyncExternalStore` loops forever if `getSnapshot` returns a fresh object.
  **Review: no blockers, all seven invariants verified intact** (each audited
  against its new home). Eight should-fixes taken, the notable ones:
  `cards`/`activeCard` were declared in the store, wired to setters and
  **written by nobody** — it advertised authority and would have handed any
  future reader `[]` forever; `getState()` was only SHALLOWLY readonly, so
  `getState().events.push(e)` compiled, mutated live state and rendered nothing
  (identity is the change signal) — fields are `readonly` arrays now;
  `if (patch.sessions || patch.groups)` became a key-presence check; and the
  store **imported from `components/`** — the state layer downstream of the
  view, which made the "test the store WITHOUT React" test pull in React,
  react-i18next and a 700-line component for three type names. Types moved to
  `model/types.ts`.
  **A correction to my own plan, found by reading the code:**
  `tearingDown`/`restoringLayout` are written by `SessionGrid` and READ BY
  `SessionCardPanel` — cross-component, so the instance refs I had planned
  would have broken them. They went into the store, deliberately OUTSIDE the
  notify path so teardown does not trigger renders.
  **An e2e failure worth recording.** `tabs.spec.ts:168` failed 2/2 full runs
  on the branch and 0/5 on main — a strict-mode violation, `.dv-active-tab`
  matching TWO elements. Cause: at that assertion the overflow dropdown is
  OPEN, and dockview renders a copy of every overflowing tab inside it,
  including the active one when it is among them. The locator was ALWAYS
  ambiguous in that case; this change shifted which tabs overflow and exposed
  it. Scoped to `.dv-tabs-container > .dv-active-tab` — the strip, which is
  what the assertion means. 2/2 full runs green after.
  *`--repeat-each` reproduced it on MAIN too, which is what proved the locator
  rather than the branch was at fault.*
  **NOT closed by this item, say so plainly:** `switchboard:popout-added` /
  `-removed` are still a window-object bus (SessionGrid → App), and
  `lib/drag-context.ts` still holds module-level mutable state. The done-when
  says "no module-level mutable state in renderer COMPONENTS", which is met —
  but AR-P1-4 is not fully closed.
  Gate: lint + typecheck + **385 unit (+23) + 83 e2e** green.

- 2026-07-28 — **P2-E15-04 (#101): §5.23's "main is the sole enforcer" is true
  in code now.** It used to be true only because there was nothing to enforce —
  the preload exposed ~60 methods and anything reaching the bridge could call
  all of them. Now 53 channels each declare one capability
  (`src/shared/ipc/capabilities.ts`) and all 43 registrations go through
  `IpcBroker`, which refuses a call whose caller lacks it. First-party is
  granted everything, so **nothing changes at runtime — that is the contract**;
  Phase 4 wires a plugin manifest into the check instead of inventing it then.
  Outbound is gated too (checked against the TARGET window), because otherwise
  a plugin would receive every session event regardless of what it declared.
  **The review was the best one yet** — it verified the Electron assumptions
  EMPIRICALLY rather than from docs (popouts genuinely have no preload, so they
  never call IPC and are deliberately never granted; `webContents.id` is never
  reused; the grant lands before `loadURL`). Two of its nine should-fixes were
  security-relevant and mine: (1) `CHANNEL_CAPABILITIES['constructor']` returned
  the Object constructor — truthy, not a Capability, and it **skipped the
  untagged-channel branch entirely**; prototype-chain lookup in a security
  primitive, now a `Map`. (2) `preflight:check` was tagged `settings.read` while
  it `execFile`s the CLI and stats `~/.claude.json` — a child process behind a
  capability named "read settings" — and `sessions:isDirectory` stats an
  ARBITRARY caller-supplied path unscoped. Both renamed for what they DO
  (`environment.probe`, `fs.probe`). Also: three outbound sends bypassed the
  broker, making my own documented invariant false; and there is now an
  **ESLint rule** banning the `ipcMain` import outside `src/main/ipc/`, because
  the type system only stops you registering an UNTAGGED channel, not
  registering outside the broker entirely.
  **The e2e investigation is the part worth remembering.**
  `slash-commands.spec.ts:77` failed **3 of 5** full runs on the branch vs
  **0 of 3** on main — a real signal, and I did not accept "pre-existing flake".
  Findings, in order: the failing assertion was the slash-command POPUP, not
  the terminal echo (so the reviewer's attach-race theory, formed without the
  error artefact, did not fit — but that race is real and is filed as **#117**);
  **zero capability refusals ever fired**, proven by writing to a fixed file
  after realising main-process `console.error` may never reach Playwright's
  output (95 grants, 0 refusals). That left the only per-frame change: every
  terminal chunk was doing a prefix scan through `capabilityFor`. Memoised it —
  worth doing regardless — and the failures stopped: **0 of 7** consecutive
  runs since, where a persisting 60% rate would make that a 0.2% coincidence.
  *Stated honestly: causation is not proven — it was never reproduced
  deterministically — but pre-memo 3/5, post-memo 0/7, main 0/3.*
  *Lesson: a diagnostic you cannot read is not a diagnostic. The first
  instrumentation pass used `console.error` from the main process and produced
  "zero refusals", which I nearly believed.*
  Gate: lint + typecheck + **376 unit (+15) + 83 e2e** green.

- 2026-07-28 — **P2-E15-03 (#100): the renderer seam is real now.** Three
  contribution points, each replacing a switch that already existed: `panel`
  (the card's view-tab strip, four hardcoded buttons + three render branches),
  `feed-block-renderer` (FeedView's seven-branch ternary; the block components
  MOVED OUT wholesale into `extensibility/feed-blocks.tsx`, byte-identical),
  and `status-bar-item` (chrome's four hardcoded spans). Deliberately
  DISSIMILAR — a panel renders a whole view and has a mount lifecycle
  (`keepMounted`, because unmounting the terminal throws away its xterm view),
  a block renderer COMPETES to claim an input and is order-sensitive, a status
  item just puts a thing on a bar. A contract that has only seen one shape of
  consumer has not been tested, which is exactly what the Phase-4 gate is
  asking about. **Consumer count 2 → 5; the gate is met for the first time.**
  One behaviour change, deliberate: **Changes is greyed rather than hidden**
  on a folderless session. §5.8 — you can always see what exists — and it
  closes a real trap, since `view.changes` switched to that tab
  unconditionally.
  **Review found 6 should-fixes; three were mine and material.** (1) A
  CIRCULAR IMPORT `bootstrap → panels → FeedView → bootstrap`, working only
  because nothing read the registry at module scope: one module-level `list()`
  in that ring and the window fails to open with a stack pointing nowhere. The
  instance moved to its own module, matching main's split. (2) I widened `view`
  to `string` without answering what happens when the persisted id names no
  panel — it rendered a BLANK CARD with no tab lit. Fixed, and fixing it
  exposed a second hole: the fallback happily selected a *disabled* panel.
  (3) Fail-open was ASYMMETRIC — I guarded the feed path and left panels and
  status items bare, in a renderer with no error boundary anywhere, so one
  throwing contribution white-screened every session's terminal. Now
  `safely()` for predicates and a `ContributionBoundary` for output.
  Also: the ordering rule was written four times **including in its own test**
  (so the done-when was asserting against its own copy and would have stayed
  green while the strip drifted); the renderer list was sorted per block per
  frame; and `PanelId` stopped at the command layer, leaving contributed panels
  unreachable from contributed commands.
  *Lesson worth keeping: when a test re-implements the rule it is testing, it
  proves the rule is writable, not that the consumer follows it.*
  Gate: lint + typecheck + **362 unit (+21) + 83 e2e** green.

- 2026-07-28 — **P2-E15-02 (#99): the extensibility seam works in both
  processes now.** The registry class lived in `src/main/extensibility/` and its
  contracts map hardcoded main's points, so the renderer had no seam at all —
  while 8 of §5.23's 9 first-party extensions ARE renderer contributions. The
  Phase-4 gate ("2–3 dissimilar internal consumers") was therefore unreachable
  by construction: count 1, unable to grow. Class moved to
  `src/shared/extensibility/registry.ts` and made generic over a per-process
  contracts map; main keeps `MainContributions` + its singleton, the renderer
  gained `RendererContributions`, a `bootstrap.ts` obeying the same
  one-module-imports-contributors rule, and `command-set` as its first real
  point. `App.tsx` resolves commands instead of importing `buildCommands` —
  behaviour-identical, verified: `list()` is registration order, so with one
  set the flattened array matches the old output and the memo deps are
  unchanged. **Consumer count 1 → 2.**
  **`event-source` DELETED** (AR-P2-13): no registrant, no consumer, no
  reference anywhere in the tree. A tombstone comment records why, so it can
  return beside the §5.14 status monitor rather than as decoration.
  **Review found 1 blocker, and it was the load-bearing one.** Both contracts
  maps were written `interface X extends ContributionMap`, which INHERITS the
  index signature — so `keyof C` collapses to `string` and point names stop
  being checked entirely: a typo, or a renderer point registered on main's
  registry, compiled clean. A straight regression against the old
  `ContributionPointId` union I thought I was preserving. Fixed by declaring
  the maps as type aliases; the `@ts-expect-error` guard added for it
  immediately caught a THIRD instance in the test file's own map.
  *Lesson: `extends` on a `Record<string, T>` constraint is a silent
  type-safety hole — the negative test is the only thing that shows it.*
  Should-fixes, all folded in: the seam was **not fail-open** (a contributor
  throwing inside App's render blanks the window — now skipped and logged, in a
  pure `buildContributedCommands` with its own tests); **cross-set collisions
  were silent** (the registry dedupes contribution ids, not the commands inside
  them — first registration wins, collisions reported, and a shadowed command
  still ships because §5.8 says hiding chrome never removes capability); the
  registry moved to **module scope** (`useMemo` is a hint React may discard, and
  E15-03 resolves contributions deep inside SessionGrid/FeedView); the
  no-main-imports guard became a real **ESLint rule** scoped to `src/shared`
  (proven to fire) rather than a regex over one file; docs counts corrected.
  Gate: lint + typecheck + **341 unit (+15) + 83 e2e** green.
  **Not done, deliberately:** main's `registerBuiltinContributions()` still
  mutates its module singleton instead of taking a registry argument the way
  the renderer's does. The renderer's shape is the better one; aligning main is
  churn #101 will touch anyway.

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

- 2026-08-01 — **P2-E15-11 (#108) MERGED as PR #130: transcript discovery stops
  hammering the disk on the thread everything else lives on.**
  `poll()` runs every 100ms and any session unbound past 10s triggered a FULL
  recursive scan of `~/.claude/projects`. **Measured, not estimated: 43 dirs,
  1,128 transcripts, 2,090 entries — a `readdirSync` per directory plus a
  `statSync` per entry, ten times a second, per unbound session ≈ 21,000
  syscalls/sec** on the one thread that also pumps every PTY, serves every IPC
  call and answers every hook. Three unbound cards tripled it.
  **The contract, and the reason it is safe: `fs.watch` is an ACCELERATOR, never
  the authority** — the same rule this file already applied to slug math. Every
  done-when guarantee is met by the timed backoff ladder ALONE (250→500→1000→
  2000ms, capped at 2s so the degraded path still fits the S-04 ~4s budget);
  the watch only makes it fast. Recursive `fs.watch` is the flakiest API in
  Node's stdlib and fail-open is a hard constraint, so it gets to be an
  optimisation and nothing more. The tail drain stays ungated on the 100ms
  tick — it is what puts words on the screen.
  **The `rename`-only event filter is load-bearing, not an optimisation:** a
  recursive watch on the projects root sees every APPEND to every transcript,
  and the CLI appends constantly during a turn, so without it the root would be
  dirty on nearly every tick and we would have rebuilt the firehose with extra
  steps.
  **Review: 1 blocker + 6 should-fixes + 6 nits; blocker and all six taken.**
  The blocker was mine and was invisible without tracing call sites: I committed
  the sweep AFTER the session loop, but `claim()` marks the root dirty when it
  binds and `claim()` only ever runs INSIDE that loop — so the post-pass cleared,
  on the same tick, the flag the bind had just raised. **The sibling notification
  that mark exists for (P2-E15-10: evidence can RETRACT) was dead in the only
  path that raises it.** Consumed in the pre-pass now, which also keeps the
  anti-starvation property that put it there.
  **Then the regression test I wrote for that blocker PASSED against the broken
  code, and the cause is the keeper: the test fixture pointed the LOG SINK at
  the projects root.** The watcher's own "transcript bound" log line created a
  file inside the tree it watches, raised a `rename`, and re-dirtied the root —
  handing the test back the sweep the bug had taken away. **The watcher was
  marking its own homework.** Harmless for the entire life of the blind 100ms
  poll; the moment the root went under `fs.watch` it silently disarmed a test.
  Log sinks get their own directory now. *Third time this project has been bitten
  by a test that could not fail (#107 twice, now this) — and the lesson that
  generalises is that the fixture is part of the system under test.*
  Five more taken, each a real defect: **`unwatch()` never released the recursive
  watch** (close every card and it lived until the process died — refcounted
  now, last one out closes it); **`widen` and the cwd-bind deadline are
  CLOCK-driven with no dirty site**, so they would have bound ~2s later than
  today — a real regression against "binds no slower than today", on exactly the
  fallback paths that only run because something already went wrong; **a
  backwards clock step** (NTP, VM resume) made the interval arithmetic negative
  and stalled discovery entirely on the fail-open path; **`markWatchFailed` was
  one-way**, so a single `ReadDirectoryChangesW` overflow — plausible on a root
  holding 1,128 transcripts — pinned the process to flat sweeps for ever (60s
  re-arm now); and **`defaultWatchFactory`, the only code that runs in
  production, had ZERO coverage** because every test injected a factory, so
  there is now a real-`fs.watch` test whose second assertion is that APPENDING
  does not raise an event, which is what actually pins the filter.
  **Four revert-proofs, each re-run:** removing the gate gives 17 readdirs vs <5
  across ~20 ticks · the naive per-session `noteSwept` starves the sibling so it
  never binds · ungating `candidateSeen` breaks an existing P2-E15-10 test
  (`awaiting-prompt` instead of `searching`, because retracting evidence every
  unswept tick holds `evidenceSince` at null and the give-up clock can never
  run) · post-pass commit fails the new sibling-retraction test.
  **macOS CI then caught a hole nothing local could have.** The new
  real-`fs.watch` test failed there with `expected 2 to be 1`: **FSEvents
  reports an APPEND as `rename`**, so the event-type filter this file called
  "load-bearing, not an optimization" **does not hold appends back on macOS at
  all.** Every write during a turn would have re-triggered discovery and
  restored the firehose on one platform, invisibly, because the only test
  covering it asserted Windows/Linux behaviour.
  **Urgency is decided by the PATH now, which is portable:** a path the watch
  has never named is a file APPEARING (sweep next tick, as before); a path
  already seen is the CLI appending to a transcript it owns (floored at the
  ladder's fastest rung); no filename at all is treated as urgent because it
  cannot be ruled out. *An earlier attempt floored ALL filesystem events — that
  bounded the storm but delayed binding by 250ms and broke five existing
  binding tests, correctly, since "binds no slower than today" is a done-when.*
  The real-fs test now asserts BEHAVIOUR rather than event counts, so it covers
  three platforms instead of passing on two and lying about the third.
  **The pattern, three for three today: every check that failed was shaped like
  the platform I happened to be on** — this, the Windows `SIGTERM` that is not
  a signal, and the smoke run that "recovered" from a stall that never
  happened. None failed loudly; all three reported success.
  Gate: lint + typecheck + **654 unit (+22) + 98 e2e**, 1 skipped, all 5 CI jobs
  green. One e2e flake (`slash-commands`) on the first full run; passed in
  isolation and on two subsequent full runs — not this change.
  **Follow-up filed, #129:** a session that has already GIVEN UP still
  full-scans the root at the 2s cap for ever (~1,050 syscalls/sec each), so
  AR-P1-8's "three unbound cards" case is REDUCED ~20x, not removed. Outside
  this item's done-when; recorded rather than implied.
  No user-facing change, so no `docs/manual/` page. DESIGN.md never specified
  the discovery mechanism (only the binding contract, untouched), so no
  amendment.
