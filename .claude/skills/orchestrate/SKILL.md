---
name: orchestrate
description: Fable-as-orchestrator — analyze the open issue queue, dispatch parallel Opus workers in isolated git worktrees, own PROGRESS.md as its single writer, merge internal PRs on green CI, queue user-facing PRs for Dan, and keep dispatching until the queue is empty or blocked. Replaces /startup + /next-item + /autopilot when Dan wants the whole milestone driven in parallel. The orchestrator NEVER implements; Opus workers do all the work.
user-invocable: true
---

Run the whole issue queue in parallel, continuously, with Fable dispatching
and Opus implementing.

**Argument (optional):** issue numbers or a track to prioritize
(`/orchestrate 140 129`), or extra notes — `$ARGUMENTS`. No argument means
**everything open in the current milestone**.

---

## Roles — the one rule that defines this skill

- **The orchestrator (this session, intended for Fable) NEVER writes product
  code.** It analyzes, dispatches, merges, bookkeeps, and reports.
- **All implementation is done by Opus workers** — `Agent` tool,
  `subagent_type: general-purpose`, **`model: "opus"` on every dispatch, no
  exceptions**. Reviews happen inside the worker (so they are Opus reviews).
- **The orchestrator is the ONLY writer of `PROGRESS.md`.** Workers never
  touch it — that file is 3,000+ lines of prose and three-way merge conflicts
  in it are unresolvable. Workers report through handoff files (below).

Everything not overridden here follows the existing workflow:
`/next-item`'s steps with `/autopilot`'s gate substitutions, `00-process.md`'s
definition of done, the DESIGN.md hard constraints, and the PHILOSOPHY litmus
test.

## Hard boundaries (always)

- **Never merge a user-facing PR.** Those queue for Dan (see Merge policy).
- **Never commit red.** A worker pushes only after its local gate is green.
- **Never touch `.claude/.env`** or put secrets anywhere git-tracked.
- **Never re-run the S-09/S-10 probes**; S-11 probes 2–6 spend real
  subscription tokens — **ask Dan before dispatching one**.
- Nothing outward-facing beyond the repo: no releases, no publishing.

## Setup (once per run)

1. Load context as `/startup` does: `.claude/CLAUDE.md`, `PROGRESS.md`,
   `gh issue list --milestone "<current>" --state open`, and the plan files
   the open issues reference.
2. **Check the main checkout for in-flight work** (`git status`,
   `git branch --show-current`). If a feature branch has uncommitted or
   unmerged work (e.g. an item awaiting commit approval from a previous
   session), **ask Dan how to resolve it before dispatching anything** —
   fold it in, commit it, or park it. Never clobber it.
3. **Worktree pool.** Maintain up to 3 long-lived worktrees as siblings of
   the repo: `C:\Projects\sb-wt-1`, `sb-wt-2`, `sb-wt-3`.
   - Create on first use: `git worktree add C:\Projects\sb-wt-<n> -b
     <branch> main`, then `npm ci` in it (~minutes; native rebuild for
     node-pty/electron runs via postinstall).
   - Reuse between issues: verify `git status` is clean, then
     `git fetch && git checkout -b <new-branch> origin/main`. A dirty
     worktree from a dead worker gets stashed to a rescue branch
     (`rescue/<date>-<issue>`) before reuse, and noted in PROGRESS.md.
   - Create lazily — only as many as the current wave needs.
4. **Write the orchestration block into `PROGRESS.md`** (top, under the
   header): run started (date), active workers (issue → worktree → branch),
   merge queue, and the single-writer rule stated explicitly so any fresh
   session knows workers' handoffs are the inputs and this file is the
   output. Update this block on every dispatch, completion, merge, and
   blocker — **it is the resume mechanism if this session dies.**
5. Handoff directory: `C:\Projects\Switchboard.ai\.claude\work_files\
   orchestrator\` (git-ignored, main checkout — one fixed place regardless
   of which worktree a worker is in).

## Queue analysis — what runs in parallel

Build a wave from the open issues:

1. **Dependency edges** from the plan files (`Depends on:`) and issue bodies.
2. **File-collision analysis:** two issues that plausibly touch the same
   subsystem never run concurrently. Known collisions to respect without
   re-deriving: the E18 spine is strictly serial; Feed-touching issues
   (#156, #91, #140) are one track; E9 presentation items share a store and
   are one serial track; anything touching the transport seam waits for the
   E18 item in flight.
3. **Classify each issue** internal vs user-facing (decides who merges):
   *user-facing* = changes anything a user sees or does (renderer UI,
   behavior, anything writing a `docs/manual/` page). When ambiguous,
   it is user-facing.
4. **Concurrency cap: 3 workers** (machine load + subscription rate limits).
   Scale down if rate-limit warnings appear in worker output.
5. **Enabling work first:** while the load-sensitive e2e flake class
   (#145) is open, wave 1 pairs one worker on it with issues that don't
   lean on e2e confidence. Full parallelism opens after it lands.

If **nothing** is parallelizable, dispatch one Opus worker on the single
unblocked item and orchestrate serially — that is still this skill's job.

## Dispatching a worker

`Agent` tool, `model: "opus"`, `run_in_background: true`, one per issue.
The prompt must contain, concretely:

- The issue number, title, and the full done-when criteria **pasted in**
  from the plan file (workers should not re-derive scope).
- Its worktree path and branch name (`feature/<issue#>-<slug>`).
- **The worker contract:**
  1. Work ONLY in your worktree. Follow `/next-item` Steps 2–9 with
     `/autopilot`'s substitutions: self-check the plan against the
     done-when + DESIGN.md instead of Gate 1; if the item is ambiguous or
     contradicts the design docs, STOP and report the specific question —
     do not guess.
  2. **Never write `PROGRESS.md`** (any copy, any worktree). Plan files,
     DESIGN.md, and `docs/manual/` may be edited when the item requires
     it — merges are serialized so conflicts surface at rebase.
  3. **e2e lock:** before `npm run e2e`, acquire the machine-wide lock by
     atomically creating directory `C:\tmp\switchboard-e2e.lock` (mkdir
     fails if it exists → wait 60s and retry). Write your issue# into
     `owner.txt` inside it. Remove the directory when the run ends,
     success or failure. A lock is stale ONLY if it is older than 45
     minutes AND no electron process has been observed across a ~5-minute
     sampling window (idle instants between spec files are normal — one
     sample proves nothing); only then steal it, and say so. **Check
     with `tasklist | grep -i electron` and READ THE LINES — never
     `grep -c`:** `tasklist | grep -ci electron` has returned 0 while
     four electron.exe were demonstrably running (observed 2026-08-08,
     run 10, #360) — a count-based check can declare a live run dead
     and corrupt it. Legitimate
     >45-minute holds are routine with three workers sharing the machine
     (learned 2026-08-02: #183 held it 91 minutes, live, during a repeat
     campaign — a clock-only rule would have corrupted two runs). Lint,
     typecheck, and unit tests need no lock. **Wait for the lock IN-TURN
     (a polling loop inside your own execution) — never by queueing a
     background job and ending your turn: your background processes DIE
     when your turn ends** (learned 2026-08-03, run 3: two workers went
     silent waiting on "queued" e2e jobs that no longer existed, and one
     orphaned job later re-acquired the lock as a zombie and burned a
     full wasted suite run). **Poll in one Bash call, run the suite in
     the NEXT call — never poll-then-run in a single command:** the
     10-minute Bash cap can kill the call between acquiring the lock
     and finishing the suite, leaving the lock orphaned while held.
     **The suite command is `npm run e2e` — `npm run test:e2e` does NOT
     exist and its exit-1 reads like a suite failure (2026-08-21, #544's
     worker lost one launch to it); put the exact command in dispatch
     prompts**
     (learned 2026-08-08, run 10: #358's combined wait-7-min-then-run
     call was killed mid-suite while holding the lock; the worker
     recovered, but only because it checked for orphan electrons and
     re-ran in separate calls). **Spell out the mechanics in every
     dispatch prompt — the abstract warning does not stick (2026-08-20:
     THREE workers in one run ended their turn to "wait", twice on a
     running suite and once on the lock, despite this clause verbatim
     in their contracts):** the full suite (~12 min) exceeds the
     10-minute Bash cap, so the worker must launch it as a background
     Bash job and poll its completion with repeated FOREGROUND calls in
     the SAME turn (each ≤9 min, as many as needed), and must never end
     its turn while a suite is running, a lock is held, or a wait is
     pending. Orchestrator side: treat any worker final message shaped
     like "waiting — will report when it finishes" as a breach signal —
     ground-truth sweep immediately, then `SendMessage` the worker with
     re-attach instructions (this recovered all three cleanly; the
     detached suites themselves survived).
  4. Gate before push: lint + typecheck + unit green, e2e green under the
     lock. **Self-review diffs against the MERGE-BASE (`git diff
     origin/main...HEAD`, triple-dot), never two-dot against a possibly
     moved origin/main** — 2026-08-21: a reviewer read the orchestrator's
     own PROGRESS commits on main as the worker's deletions and raised a
     false Blocker; put this in reviewer subagent prompts too. **Gate-number integrity: a count the worker did not personally
     read off an actual counts line in real output does not exist. A
     missing, empty, or truncated output file means the run is VOID — say
     so and re-run it; never reconstruct, remember, or infer a number**
     (2026-08-20: #488's worker reported "335 passed, exit 0" from a
     monitor that had produced zero events over an empty output file,
     then self-retracted; the figure was coincidentally correct, which is
     exactly why reconstruction is dangerous — the PR's genuine green CI
     was the evidence that actually held). Review your own diff against
     `/review`'s standards (you are
     Opus; the review is yours) — fix Blockers/Should-fixes, ~3 rounds cap.
     **Mutation/revert experiments must stash or commit the working
     state FIRST — never raw `git checkout --` over uncommitted work**
     (run 14: #388's mutation harness restored with git checkout and
     ate the uncommitted source edits; recovered from context, no loss,
     but only by luck of a small diff).
     **Any subagent you spawn (reviewer, debugger) inherits every safety
     constraint in this contract — restate destructive-work clauses
     ("fixtures only", "never touch real %TEMP%", token limits) verbatim
     in the subagent's prompt** (learned 2026-08-08, run 10: #354's
     reviewer, told to verify behaviour empirically but not told the
     live %TEMP% was off limits, ran the unbudgeted sweep CLI and
     deleted ~81,600 real directories — all within the filter, no loss,
     but outside the sanctioned envelope).
  5. User-facing items write their `docs/manual/` page before the PR — a
     missing page is a failing gate, exactly as in `/autopilot`.
  6. Push and open a **draft PR**: title `<item-id>: <title>`, body has
     `Closes #<n>`, the plain-English "What this does", and the numbered
     "What to test" checklist (`00-process.md` → The hand-off).
  7. Write your handoff to `<handoff-dir>\<issue#>.md`: status
     (done/blocked/question), PR URL, gate results (exact test counts),
     the two hand-off sections, anything discovered out of scope (report,
     don't fix — the orchestrator files it), and any DESIGN divergence.
  8. Your final agent message: a 10-line summary of the same.

**Mid-flight discoveries:** a worker that finds an unrelated bug reports it
in the handoff; the orchestrator files it as a new issue (`gh issue create`)
and queues it. No scope creep on open PRs. **A citation-drift or
doc-contradiction finding must quote the section BODY it checked, not the
heading** — run 11: #358 reported a "stale §5.26 citation" off the section
heading alone; the rule was in the body all along, and the follow-up item
(#367) existed only to disprove the report. Workers' prompts for such
findings should demand the quoted evidence before an issue is filed.
*(#369 has since promoted that a11y material to its own §5.32, so the example
no longer reproduces — the lesson about quoting the body does.)*

## While workers run — the orchestrator loop

On each worker completion notification:

1. Read the handoff file (and the agent's summary). Update `PROGRESS.md`:
   the orchestration block, plus a normal item entry (done/blocked + one-line
   outcome + PR link) in the style the file already uses.
2. **Blocked or questioning worker:** if the question is Dan's, surface it
   and move on to other tracks; if other tracks depend on it, stop the run
   and report. Use `SendMessage` to continue a worker whose question you can
   answer from the docs.
3. **Merge queue:**
   - **Internal PR:** mark it ready-for-review THE MOMENT you process its
     handoff (a draft cannot merge, and `gh pr merge` on a draft fails),
     wait for green CI, then squash-merge (`gh pr merge --squash`), confirm
     the issue closed, delete the branch. **Delete a PR's head branch ONLY
     after confirming the PR state is MERGED — and never chain
     merge-then-delete-then-push with `;` (2026-08-21: a draft-state merge
     failure was plowed past by the `;` chain and the branch delete ORPHANED
     the open PR; recovery = fetch `refs/pull/<n>/head`, push it back as the
     branch, reopen). Destructive follow-ups go in a separate call after
     reading the merge result.**
     If main moved under it, bump (`update-branch`) and re-green first —
     internals merge as they finish, so this stays rare. **Branch
     protection is STRICT up-to-date (learned 2026-08-21): ANY commit to
     main — including the orchestrator's own PROGRESS doc commits —
     invalidates every open PR's mergeability and forces a full
     update-branch + re-green cycle.** So: batch PROGRESS pushes and
     prefer landing them immediately AFTER a merge (when open PRs are
     already invalidated), never between a PR going green and its merge;
     and when two internal PRs race, merge the up-to-date one first,
     then update-branch the other once (`gh pr merge --auto --squash`
     after the bump lands it unattended). **Exception —
     wide mechanical internals while a train is pending (2026-08-20,
     #255-T0):** an internal PR whose diff brushes many files (lint
     campaigns, format sweeps) is PARKED green-and-unmerged until after
     the train — merging it first would force every queued feature PR to
     absorb its conflicts; one rebase of the mechanical PR afterward is
     strictly less work.
   - **User-facing PR:** mark ready-for-review, add it to Dan's queue in the
     orchestration block with its test checklist. **Do not merge.**
   - **The batch merge is a TRAIN BRANCH, not a serial bump chain (Dan,
     2026-08-06 — run 6's serial train burned ~17 full CI runs / ~5 hours
     re-verifying already-green PRs).** When Dan authorizes the queue:
     1. `git fetch origin main` FRESH — run 6 lost an hour to an integration
        merge built on a stale local `origin/main` ref. Fetch before EVERY
        integration merge, not once per session.
     2. `git checkout -b train/<yyyy-mm-dd> origin/main` in the main checkout.
     3. Merge each queued feature branch in the report's suggested order.
        Resolve conflicts and the flagged semantic integrations in one
        sitting; verify each with targeted unit tests, and **read the counts
        line (`Tests  N passed`), never the output tail** — run 6 pushed red
        once off a truncated-tail misread.
     4. Run the FULL local gate once on the train tree (lint, typecheck,
        unit, e2e under the machine lock).
     5. Push, open one PR titled `train: <date> — #a #b #c …` whose body
        lists every contained PR and `Closes #<issue>` line. ONE CI run.
     6. On green: **merge commit, not squash** (`gh pr merge --merge`) — the
        contained branches' commits reaching main is what flips every
        member PR to "merged" and fires its issue closes. The per-PR-squash
        history is deliberately given up here (Dan accepted the trade).
     7. Delete the feature branches; verify every member PR shows merged
        and every issue closed. If the one CI run fails, fix ON the train
        branch and re-run — still one lane, not N.
   - Idle worktrees rebase onto fresh main after the train lands.
4. **Dispatch the next unblocked issue** into the freed worktree. Re-run the
   queue analysis — merges change what is unblocked.
5. Between notifications, schedule a fallback wakeup (20–30 min) so a hung
   worker can't stall the run silently. **GROUND-TRUTH SWEEP: completion
   notifications CAN be silently lost and workers CAN die unnoticed (run
   13, 2026-08-09: one of each in a single run — a finished worker whose
   notification never arrived, and a dead worker whose task id was no
   longer even queryable).** A worker silent past ~60–90 min gets a
   ground-truth sweep BEFORE any conclusion: its worktree's `git status`,
   its handoff file's existence, `gh pr list` for its branch, and the
   e2e lock owner. `TaskOutput` alone is not evidence — it can answer
   "no task found" for both a finished and a dead worker. A dead
   worker's uncommitted WIP can be recovered IN SITU by a fresh worker
   told to verify-then-keep (run 13's #191 recovery kept essentially
   all of it after re-verifying every load-bearing claim — cheaper and
   better than a rescue-stash + restart). Refinement of the run-3
   waiter note: detached processes MAY survive a worker's turn end (a
   full e2e suite did, run 13); it is the worker's *notifications and
   waiters* that reliably die — so in-turn polling remains the only
   safe shape, and an orphaned-but-live suite is a state the sweep
   must anticipate.

## Planning (the /pm slice this skill owns)

- When the filed queue runs dry but a plan file has **fully-specified,
  unfiled items** (done-when written, not gated on unmeasured probes): file
  them (`gh issue create`, milestone + labels, per `00-process.md`) and keep
  going. Announce what was filed.
- **Expanding an outline epic (E9's tail, E11, E13, E14) into new work items
  is a scoping decision: ASK Dan first.** Same for anything gated on S-11
  probes — the gate is real, do not file against guesses.
- Keep dependency notes in the plan files current as items close.

## Stop conditions (end the run and report)

- Queue empty and nothing fileable without Dan.
- A blocker every remaining track depends on.
- Repeated environment breakage (CLI logged out, CI infra down) a debugger
  pass can't resolve.
- Rate limits exhausted — report what's parked and when to resume.

## Final report

1. Shipped: one line per item, merged vs awaiting-Dan.
2. **Dan's queue:** user-facing PRs to review + the combined, ordered
   hand-test list (his time is the scarcest resource — batch it).
   **Before handing over the list: `npm run build` in the MAIN checkout
   and verify the baked stamp matches HEAD** (learned 2026-08-04, run 4:
   `npm start` is preview — it builds nothing, and workers build only in
   their worktrees, so the main checkout's `out/` is always stale after
   a run; Dan's first test step is confirming the About-panel stamp).
3. Blocked/skipped: why, and the exact question or action Dan owes.
4. Issues filed mid-run. 5. Worktree pool state. 6. Recommended next step.
7. **Plain-English summary (added 2026-08-05, Dan's request): end EVERY
   run's final report with a section titled "In plain English" —** a short
   narrative (a few paragraphs, not a table) that a person who read none of
   the run's PRs, issues, or jargon can follow. Rules: describe what the
   *app* now does differently, not what the *code* looks like ("the app can
   now install its own updates", not "electron-builder config landed");
   no issue/PR numbers except in parentheses where genuinely helpful; no
   internal codenames (worktrees, gates, locks, CI) unless the sentence is
   *about* them; group by theme, not by chronology; and say plainly what
   still doesn't work or waits on Dan. Write it LAST, after the technical
   sections, so it summarizes the real outcome — and if the run ends early
   (blocker, rate limits), the section still appears and says what got done
   and what didn't.

## Notes

- This skill assumes Fable is the session model, but the contract is
  role-based: whoever orchestrates never implements, and workers are always
  explicitly `model: "opus"` — so it degrades safely if invoked from Opus.
- `/next-item` and `/autopilot` remain for single-track work with Dan at or
  away from the keyboard; this skill supersedes them only while a run is
  active. Do not run it concurrently with either.
