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
boundaries · DESIGN.md amended if the implementation diverged from it.

## Plan files

- `01-spike-foundations.md` — de-risking spike (current)
- `02-phase-1-mvp.md` — Phase 1 work items (next)
- `03-later-phases.md` — Phases 2–4 outlines, expanded just-in-time
