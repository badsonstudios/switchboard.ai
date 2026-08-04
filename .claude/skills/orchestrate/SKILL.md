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
     sample proves nothing); only then steal it, and say so. Legitimate
     >45-minute holds are routine with three workers sharing the machine
     (learned 2026-08-02: #183 held it 91 minutes, live, during a repeat
     campaign — a clock-only rule would have corrupted two runs). Lint,
     typecheck, and unit tests need no lock. **Wait for the lock IN-TURN
     (a polling loop inside your own execution) — never by queueing a
     background job and ending your turn: your background processes DIE
     when your turn ends** (learned 2026-08-03, run 3: two workers went
     silent waiting on "queued" e2e jobs that no longer existed, and one
     orphaned job later re-acquired the lock as a zombie and burned a
     full wasted suite run).
  4. Gate before push: lint + typecheck + unit green, e2e green under the
     lock. Review your own diff against `/review`'s standards (you are
     Opus; the review is yours) — fix Blockers/Should-fixes, ~3 rounds cap.
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
and queues it. No scope creep on open PRs.

## While workers run — the orchestrator loop

On each worker completion notification:

1. Read the handoff file (and the agent's summary). Update `PROGRESS.md`:
   the orchestration block, plus a normal item entry (done/blocked + one-line
   outcome + PR link) in the style the file already uses.
2. **Blocked or questioning worker:** if the question is Dan's, surface it
   and move on to other tracks; if other tracks depend on it, stop the run
   and report. Use `SendMessage` to continue a worker whose question you can
   answer from the docs.
3. **Merge queue (serial, one at a time):**
   - **Internal PR:** wait for green CI (5 jobs), then squash-merge
     (`gh pr merge --squash`), confirm the issue closed, delete the branch.
   - **User-facing PR:** mark ready-for-review, add it to Dan's queue in the
     orchestration block with its test checklist. **Do not merge.**
   - After ANY merge to main, the next PR in the queue rebases onto fresh
     `main` and CI re-runs before it can merge. Idle worktrees rebase too.
4. **Dispatch the next unblocked issue** into the freed worktree. Re-run the
   queue analysis — merges change what is unblocked.
5. Between notifications, schedule a fallback wakeup (20–30 min) so a hung
   worker can't stall the run silently. A worker silent past ~90 min gets
   checked (`TaskOutput`), then killed and its worktree rescued if wedged.

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
3. Blocked/skipped: why, and the exact question or action Dan owes.
4. Issues filed mid-run. 5. Worktree pool state. 6. Recommended next step.

## Notes

- This skill assumes Fable is the session model, but the contract is
  role-based: whoever orchestrates never implements, and workers are always
  explicitly `model: "opus"` — so it degrades safely if invoked from Opus.
- `/next-item` and `/autopilot` remain for single-track work with Dan at or
  away from the keyboard; this skill supersedes them only while a run is
  active. Do not run it concurrently with either.
