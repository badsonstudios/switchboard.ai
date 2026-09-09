---
name: next-item
description: End-to-end orchestrator for a work item — pick the next open GitHub issue in the current milestone (or a named item like S-03 / #3), plan, implement, test until green, code review, iterate, open the PR and merge it on green CI, then report. Runs start to finish without stopping for approval; the one checkpoint is the plain-English report at the end. Updates PROGRESS.md at start and finish.
user-invocable: true
---

Drive one work item from open issue to merged PR.

**Argument (optional):** an item ID (`S-03`, `P1-E2-01`), an issue number
(`#3` or `3`), and/or extra notes — `$ARGUMENTS`. No argument means **"do the
next item"**: the lowest-numbered open, unblocked issue in the current
milestone. If the current milestone has no open issues, say so and suggest
`/pm file-issues <next phase>`.

This skill **orchestrates** other skills and agents, and it **runs start to
finish without stopping for approval**.

## The one checkpoint (changed 2026-09-08 — read this before looking for a gate)

There is **exactly one** place this skill hands back: **Step 11, after the PR is
open, CI is green, and the work is merged.** That report is the oversight point,
and it is a *report*, not a request — Dan reads it and tells you if he wants
something changed or reverted.

This replaced two blocking gates (plan approval before implementing, commit
approval before pushing). Dan removed them on 2026-09-08 and chose, explicitly,
that the final checkpoint does **not** block the merge: "merge on green CI; the
summary is a report." That keeps the 2026-09-01 decision intact — **the gate is
green CI, not a human click** — and means an item never parks waiting on
someone.

**So: do not invent a new gate.** Do not ask "shall I proceed?", "does the plan
look right?", or "ready for me to commit?". Do not route back through
`/commit-push-pr`'s old approval step. If you hit something that genuinely needs
Dan — a decision only he can make, a blocker, an item marked `[user]` — stop and
say so plainly; that is a blocker, not a gate, and it is still allowed.

**Judgment calls are yours to make now.** Where the old flow would have surfaced
a choice at Gate 1, pick the better option, state which you picked and why in
the Step 11 report, and keep going. A design question you sat on until approval
is a question that costs a round trip for nothing.

---

## Step 1 — Pick up the item

1. Read **`PROGRESS.md`** first:
   - If an item is already **in progress**, resume it — tell the user where it
     stands and continue from the right step below.
   - Otherwise resolve the argument to an issue, or take the next open,
     unblocked issue in the current milestone:
     `gh issue list --milestone "<current>" --state open`.
2. Read the issue body AND its spec section in the plan file it references
   (`docs/plans/*.md`) — the plan file carries the full done-when criteria and
   dependencies; the issue is the tracker. DESIGN.md sections cited by the plan
   are the spec — don't improvise scope.
3. Check dependencies: if the item's "Depends on" issues aren't closed, flag it
   and pick the next unblocked one (or ask).
4. Restate the goal and done-when criteria in your own words, and **update
   `PROGRESS.md` now**: item in progress + timestamp. Comment on the issue that
   work started.
5. If the item is ambiguous, under-specified, or contradicts DESIGN.md, ask
   before planning — don't guess.

## Step 2 — Create a plan

For a non-trivial item, delegate to the **Plan** agent; otherwise plan inline.
The plan must be concrete:

- Files/modules to change (and why) — respect DESIGN.md §5 architecture and the
  extensibility seams (§5.23: new features go through contribution interfaces
  where cheap).
- The approach and trade-offs (refs: `references/architecture.md`,
  `references/tech-stack.md`).
- Tests to add/update (see `references/testing.md`) — spike items produce
  findings notes instead.
- Risks, edge cases, and anything explicitly **out of scope**.

Sanity-check the plan against the **PHILOSOPHY.md litmus test** when the item
ships user-facing behavior.

## Step 3 — Record the plan, then keep going

**Post the plan as a comment on the issue** and move straight on to Step 4. Do
not wait for a reply.

This is what is left of the old plan-approval gate, and it is worth the thirty
seconds for two reasons that have nothing to do with approval:

- **It is the artifact Dan can read while you work** — asynchronously, on his
  phone, or never. A plan that exists only in a chat transcript is gone the
  moment the context is summarized.
- **It dates the reasoning against the issue.** Every one of the last three
  items produced a decision worth finding again six weeks later ("why is the bus
  not awaited on the spawn path?"). On the issue it is findable; in chat it is
  not.

Keep it short — the decisions and the trade-offs, not a file list. If the plan
turns out to be wrong halfway through Step 4, say so in the Step 11 report and
in a follow-up issue comment; do not silently ship something else.

## Step 4 — Implement

- If on `main`, branch first: `git checkout -b feature/<item-id-slug>` (e.g.
  `feature/s-01-pty-host`).
- Implement to the plan from Step 2. Follow `references/code-style.md`
  (incl. the no-raw-colors / no-hardcoded-strings rules once the lint
  infrastructure exists).
- **Diverging from the plan is allowed and often right** — the plan was written
  before the code was touched. What is not allowed is diverging silently: note
  it on the issue and in the Step 11 report.

## Step 5 — Test (iterate until green)

Build and test per `references/testing.md` (per-item commands until the Phase 1
scaffold lands; then `npm run build` / `npm test`; run the app to see the
change actually work when there's a runtime surface). On failure: diagnose
(use the **debugger** agent for non-obvious causes) → fix → re-run. Loop until
green. If genuinely blocked, **record the blocker in `PROGRESS.md`** and stop
with the failing output — never report half-working code as done.

## Step 6 — Code review

Run **`/review`** on the diff. Triage findings into **Blocker / Should-fix / Nit**.

## Step 7 — Iterate

Address Blockers/Should-fixes, then back to Step 5 and Step 6. Repeat until
green + no remaining Blocker/Should-fix (Nits may be noted). Cap ~3 rounds; if
not converging, record state in `PROGRESS.md` and report.

## Step 8 — Update documentation

- **Done-when check:** walk the item's criteria explicitly — every point either
  met or explained.
- **User docs (required for anything user-facing):** write or update the
  relevant page in **`docs/manual/`** — before the PR, while the feature is
  fresh. One page per user-facing area, not per work item; `docs/manual/README.md`
  is the index + house style, `_template.md` the skeleton. Plain English,
  second person, name the real buttons; no issue numbers, item IDs, or `src/`
  paths. A rough draft or `TODO:` placeholder is fine — nothing at all is not.
  Update the index's status column when a page graduates stub → draft → current.
  Purely internal work (refactor, CI, tests) writes nothing: say "no user-facing
  change".
- **CHANGELOG entry (required for anything user-facing) — added 2026-08-17.**
  Add it to the **topmost `— unreleased` section** of `CHANGELOG.md`, under
  `Added` / `Changed` / `Fixed` / `Internal`, in the user's words rather than
  the issue's. That file's own "While work is landing" section is the rule; this
  line exists because it was being missed. **v0.7.0 was cut with an EMPTY
  section** — three consecutive items had shipped without filing — and the
  release commit had to write four entries retroactively from git log and
  PROGRESS. The in-app update dialog shows these notes to the user, so a blank
  section is a user-visible miss, not a tidiness one. Never open a second
  unreleased section; if there is none at all, open one and say so in the PR.
- Spike items: write/update the findings note the item requires.
- If implementation diverged from DESIGN.md, amend DESIGN.md **before**
  committing (that's the definition of done in `docs/plans/00-process.md`).
- If nothing doc-worthy changed, say "no doc changes needed".

## Step 9 — Hand-off: plain English + what to test

**Write both parts here, then use them twice**: in the PR body (Step 10) and as
the top of the Step 11 report. They come **before** the technical summary in
both places, and neither is ever skipped.

This matters more now, not less. It used to be the thing Dan read before
deciding to merge; since 2026-09-08 the merge has already happened by the time
he sees it, so this is the *only* description of the change he is offered. If it
is vague, he has no way to notice something is wrong short of reading the diff.
Two parts, in this order:

### A. What this does — in plain English

Three to six sentences a non-programmer could follow. What can you *do* now
that you couldn't before, and why is that better? Name the real buttons, keys,
and labels. **No** file paths, item IDs, issue numbers, function names, or
test counts — those live in the technical summary below it.

Say what it deliberately does **not** do when leaving that out would surprise
him (a known limitation, a platform where it won't fire, a case that still
falls back to the old behavior). Two lines, not a disclaimer essay.

This is not a duplicate of the `docs/manual/` page from Step 8: the manual is
standing reference written for a stranger; this is "here is what just landed",
written for the person about to review it.

### B. What to test — a numbered list

A short **numbered** list of things for Dan to actually try. Each item is one
action plus what he should see:

> 3. Drag a popped-out session to your second monitor, quit, relaunch — it
>    should come back on that monitor, same size, not straddling the boundary.

Rules that keep the list worth reading:

- **Lead with what the automated tests already cover**, in one line, so he
  never repeats work a machine did. Then list only what genuinely needs a
  human: visual judgment, multi-monitor, real `claude` CLI behavior, timing
  and feel, anything the fake provider can't produce. This is the existing
  **[Dan eyeball]** convention, itemized instead of buried in prose.
- **Order it:** the core new behavior first, then edge cases, then anything
  nearby that this change could plausibly have broken.
- **Include the setup** when a check needs one ("open two sessions in
  different folders first").
- **Say what "correct" looks like** for each item — a test he can't fail is
  not a test.
- **Keep it to 3–7 items.** If it won't fit, the work item was too big; say so.
- If a criterion genuinely can't be verified by hand (CI-only, needs hardware
  we don't have), say that explicitly rather than padding the list.

Purely internal work (refactor, CI, tests) still gets part A in one or two
sentences, and part B says "nothing to click — this is internal; the gate is
the test suite."

## Step 10 — Ship it

No approval step. **Rebase onto `main` first**, then run **`/commit-push-pr`** —
PR title `<item-id>: <title>`, body carries `Closes #<issue>` **and Step 9's
plain-English summary + test list** (that's what makes the PR reviewable weeks
later, and on GitHub Dan can tick the boxes as he goes).

**Then MERGE IT YOURSELF once CI is green** — `gh pr merge <n> --squash
--delete-branch`, then `git checkout main && git pull`.

**The gate is green CI, not a human.** This step used to read "Dan reviews and
squash-merges — never self-merge", which was stale and actively wrong: it left
PRs sitting for a human click Dan does not make and does not want to make
(corrected by him 2026-09-01, "you've always been merging it"; re-confirmed
2026-09-08 when he removed the two approval gates and chose merge-on-green over
a blocking final gate). Reviews are deliberately NOT required on `main` — that
is a decision, not an oversight, so do not re-add one and do not reach for
`--admin` to get around a check that is genuinely failing. **If CI is red, it
does not merge** — fix it or report the blocker.

Close out the tracking before you report (never skip):

- Update `PROGRESS.md`: item **done** with date + one-line outcome + PR link;
  set **Next up** to the following open issue; clear stale notes.
- Update `docs/plans/dogfood-testing.md` if anything user-facing merged — add it
  as UNTESTED with a how-to-test line. Automatic, no asking.
- The issue closes itself on merge via `Closes #<n>`.

## Step 11 — The report (the one checkpoint)

Hand back to Dan, in this order:

1. **`Summary:`** — the plain-English paragraph from Step 9A. Two to four
   sentences, no jargon, no paths, no identifiers. This is the part he is
   actually going to read.
2. **What to test** — the numbered list from Step 9B, verbatim.
3. **Then the technical detail**, kept tight: what changed, test status, review
   outcome, done-when walked point by point, docs updated (or why none), **and
   every judgment call you made that the old Gate 1 would have asked about** —
   what you chose and why, so disagreeing is one sentence of his time.
4. The PR URL, that it is merged, and what's next.

It is a report, not a request. Do not end it with a question about whether the
work was acceptable.

---

## Notes

- **There is one checkpoint and it is Step 11.** Steps 1–10 run without stopping.
  A genuine blocker or a `[user]` item still stops the run — say so plainly and
  record it in `PROGRESS.md`.
- **PROGRESS.md is the session-survival mechanism** — update at pickup, on any
  blocker, and at close-out, so a fresh session can resume from the file alone.
- Never commit `.claude/.env` or secrets (a hook also blocks staging `.env`).
- This skill is the back end of **`/pm`** — `/pm` shapes plans and files
  issues; `/next-item` ships them.
