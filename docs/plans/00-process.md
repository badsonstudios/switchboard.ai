# Development Process

How switchboard.ai gets built: phases → work items → issues → PRs, with the
owner overseeing rather than typing most of the code.

## The layers

| Layer | Lives in | Granularity | Churn |
|---|---|---|---|
| Design | docs/DESIGN.md + PHILOSOPHY.md | features & principles | slow — amended deliberately |
| Plans | docs/plans/*.md | phases → epics → work items | medium — re-planned per phase |
| Execution | GitHub issues + PRs | one work item = one issue = one PR | fast — daily |

Rule of thumb: DESIGN.md says *what and why*, plans say *in what order and how
big*, issues say *who's doing it right now and what's blocking*. Content flows
downward; nothing is duplicated upward (an issue links to its plan item, a plan
item cites its DESIGN.md section).

## Work item format

Every work item in a plan file carries:
- **ID** (`P1-E2-03` = Phase 1, Epic 2, item 3; spike items are `S-01`…)
- **What** — one or two sentences
- **Done when** — observable acceptance criteria, not vibes
- **Size** — S (≤half a day) / M (a day or two) / L (needs splitting before work starts)
- **Depends on** — item IDs, when ordering matters

## GitHub: when and how (decided 2026-07-18)

**Create the GitHub repo and push: now.** Benefits are immediate — offsite
backup, issues, PR review surface, and Claude Code's GitHub integration for
review workflows. Private until the name check (OQ #6) and a deliberate
public-release decision.

**File issues just-in-time, never in bulk.** Milestones mirror phases
(`spike`, `phase-1`, …). Issues get created for the CURRENT milestone only:
spike issues now; Phase 1 issues when the spike exits; Phase 2 issues when
Phase 1 ships. Rationale: the design will keep moving — a bulk-filed backlog
of 100+ issues rots instantly and buries signal. The plans folder holds the
future; the issue tracker holds the present.

**The oversight loop (owner as reviewer):**
1. Work item → issue (labels: milestone + epic area).
2. Implementation happens on a branch — typically a Claude Code session
   (eventually inside switchboard.ai itself — dogfooding day is a milestone).
3. Branch → PR referencing the issue. CI runs (build on Win/mac/Linux, lint,
   tests).
4. **Owner reviews the PR** — this is the primary oversight point. Merge closes
   the issue.
5. Anything discovered mid-item that isn't in scope → new issue, not scope
   creep on the open PR.

**Definition of done (every PR):** acceptance criteria met · CI green · no
hardcoded strings or raw colors (lint enforces) · logging on new subsystem
boundaries · DESIGN.md amended if the implementation diverged from it ·
**user documentation written (see below)** · **plain-English hand-off + test
list delivered (see below)**.

## The hand-off: plain English + what to test (added 2026-07-26)

Every work item ends by telling the owner, **before** the technical summary and
**before** the PR opens, two things:

1. **What this does** — a few sentences a non-programmer could follow. What can
   you do now that you couldn't, and why is that better? Real button, key, and
   label names; no file paths, item IDs, or function names. Call out anything
   it deliberately doesn't do where leaving that out would surprise him.
2. **What to test** — a short **numbered** list of things to actually try, each
   one an action plus what he should see. Lead with a one-liner on what the
   automated tests already cover, then list only what needs a human: visual
   judgment, multi-monitor, real `claude` CLI behavior, timing and feel. Order
   it core behavior → edge cases → nearby regression risk. 3–7 items; if it
   won't fit, the work item was too big.

- **Where:** `/next-item` Step 9, before Gate 2. The same two sections go into
  the **PR body** (test list as GitHub checkboxes, so it can be ticked off
  during review), and into `/autopilot`'s draft-PR description per item — where
  it matters most, since nobody watched the run.
- **Why it's separate from `docs/manual/`:** the manual is standing reference
  written for a stranger who has never seen the app. The hand-off is "here is
  what just landed", written for the person deciding whether to merge it. One
  is a product; the other is a delivery note.
- **Purely internal items** get one or two sentences for part 1, and part 2
  says "nothing to click — the gate is the test suite."

## User documentation (added 2026-07-24)

Every work item that changes something a **user** can see or do writes or
updates its page in `docs/manual/` **before the PR opens** — while the feature
is fresh, not reconstructed from a diff months later.

- **Where:** `docs/manual/`, one page per user-facing area (not per work item).
  `docs/manual/README.md` is the index and the house style guide;
  `_template.md` is the starting skeleton.
- **When:** `/next-item` Step 8, alongside the done-when check. `/commit-push-pr`
  refuses to open the PR without it.
- **Audience:** someone using the app, who has never read DESIGN.md. Plain
  English, second person, name the actual buttons. No issue numbers, work-item
  IDs, or `src/` paths.
- **Good enough beats perfect.** A rough draft or a `TODO:` placeholder is an
  acceptable page. No page at all is not.
- **Purely internal items** (refactors, CI, test harnesses) write nothing —
  say "no user-facing change" in the Gate 2 summary and move on.

These pages are the **source for the shipped HTML manual** — the compile step
is a planned work item (`03-later-phases.md` → "User manual build"). Writing
them as we go is what makes that item small.

## Plan files

- `01-spike-foundations.md` — de-risking spike (current)
- `02-phase-1-mvp.md` — Phase 1 work items (next)
- `03-later-phases.md` — Phases 2–4 outlines, expanded just-in-time

## Other docs

- `docs/manual/` — the user manual (Markdown source; see above)
