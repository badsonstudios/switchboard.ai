---
name: next-item
description: End-to-end orchestrator for a work item — pick the next open GitHub issue in the current milestone (or a named item like S-03 / #3), plan, get the plan approved, implement, test until green, code review, iterate, then commit/push/PR after approval. Updates PROGRESS.md at start and finish.
user-invocable: true
---

Drive one work item from open issue to merged PR.

**Argument (optional):** an item ID (`S-03`, `P1-E2-01`), an issue number
(`#3` or `3`), and/or extra notes — `$ARGUMENTS`. No argument means **"do the
next item"**: the lowest-numbered open, unblocked issue in the current
milestone. If the current milestone has no open issues, say so and suggest
`/pm file-issues <next phase>`.

This skill **orchestrates** other skills and agents. It has **two mandatory
human approval gates** — plan approval (Step 3) and commit approval (Step 10) —
that are **never** skipped, even if the user said "go ahead" earlier for a
different step.

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

## Step 3 — Approval gate #1 (plan)

**CRITICAL:** Present the plan and **wait for explicit approval**. No
implementation code before approval. If changes are requested, revise and
re-present.

## Step 4 — Implement

- If on `main`, branch first: `git checkout -b feature/<item-id-slug>` (e.g.
  `feature/s-01-pty-host`).
- Implement exactly to the approved plan. Follow `references/code-style.md`
  (incl. the no-raw-colors / no-hardcoded-strings rules once the lint
  infrastructure exists).

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

**This comes before the technical summary, not after it, and it is never
skipped.** Dan has to decide whether to merge; he shouldn't have to reverse-
engineer a diff to do it. Two parts, in this order:

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

## Step 10 — Approval gate #2 (commit)

Now the technical summary: what changed, test status, review outcome, files
touched, done-when status, docs updated (or why none). **Wait for explicit
approval to commit and open the PR.**

## Step 11 — Commit, push, PR, close out

1. Run **`/commit-push-pr`** — PR title `<item-id>: <title>`, body includes
   `Closes #<issue>` **and Step 9's plain-English summary + test list** (that's
   what makes the PR reviewable weeks later, and on GitHub he can tick the
   boxes as he goes). Dan reviews and squash-merges — that's the oversight
   point; never self-merge.
2. **Close out the tracking (never skip):**
   - Update `PROGRESS.md`: item **done** with date + one-line outcome + PR
     link; set **Next up** to the following open issue; clear stale notes.
   - The issue closes automatically on merge via `Closes #<n>`.
3. Report: what shipped, the PR URL, and what's next.

---

## Notes

- The two approval gates are non-negotiable.
- **PROGRESS.md is the session-survival mechanism** — update at pickup, on any
  blocker, and at close-out, so a fresh session can resume from the file alone.
- Never commit `.claude/.env` or secrets (a hook also blocks staging `.env`).
- This skill is the back end of **`/pm`** — `/pm` shapes plans and files
  issues; `/next-item` ships them.
