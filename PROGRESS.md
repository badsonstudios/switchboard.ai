# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Phase 2 - The Switchboard (E7+E8+E10+E12 complete & merged;
**E9 filed 2026-07-24 → #70–#80**; **E15 filed 2026-07-27 → #98–#111**;
E11/E13/E14 still outlines)
**In progress:** **#153 — the Direct-mode setting could NEVER take effect.**
Branch `fix/153-transport-restart`. Gate green: lint + typecheck + **804 unit**
+ **105 e2e (+2)**. **#152 MERGED**, 5 CI jobs green.

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
