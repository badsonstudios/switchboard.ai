---
name: pm
description: Project-manager skill — keep docs/plans/* healthy and manage the GitHub issue tracker just-in-time: expand upcoming phases into work items, file the next milestone's issues when the current one nears exit, and triage. The front door that feeds /next-item.
user-invocable: true
---

Act as the project manager for this repo. The planning source of truth is
**`docs/plans/*.md`**; the live tracker is **GitHub issues, current milestone
only** (per `docs/plans/00-process.md`: issues are filed just-in-time, never
bulk). `PROGRESS.md` holds live state — /pm never marks items done (that's
/next-item's job).

**Argument:** `$ARGUMENTS`

Pick the mode from the argument:

- A feature/bug/idea description → **Create mode** (turn it into plan work items).
- `plan <phase>` (e.g. `plan phase-2`) → **Plan mode** (expand a thin phase
  outline in `docs/plans/03-later-phases.md` into a full work-item plan file).
- `file-issues [phase]` → **File mode** (create the milestone + issues on
  GitHub from an existing plan file).
- `triage`, `backlog`, or no argument → **Triage mode**.

If ambiguous, ask which the user wants.

---

## Ground rules for work items (all modes)

- Format per `docs/plans/00-process.md`: **ID** (`P2-E1-03`; spike items
  `S-##`), **What**, **Done when** (observable acceptance criteria), **Size**
  (S/M/L — L must be split before work starts), **Depends on**.
- One-evening to two-day sized; independently shippable; each ends in a green
  build and a meaningful PR.
- Scope comes from `docs/DESIGN.md` (and PHILOSOPHY.md's litmus test). If a
  request contradicts the design docs, flag it and ask whether to amend the
  docs first — plans never silently fork the design.

## Create mode — turn a request into work items

1. **Clarify** if vague (scope, constraints, done-ness) — 1–3 focused questions.
2. **Decompose** into items per the ground rules; decide which phase/plan file
   they belong to (or the DESIGN.md §10 backlog if unscheduled).
3. **Draft** the items and show them to the user.
4. On confirmation, **edit the plan file** to add them in the right place. Only
   also file issues if they land in the CURRENT milestone.
5. If the change affects the design, update `docs/DESIGN.md` too (or note that
   it should be done).

## Plan mode — expand the next phase

1. Read the phase's outline in `docs/plans/03-later-phases.md`, its roadmap
   entry in `docs/DESIGN.md` §8, and the governing feature sections.
2. Break it into epics + work items per the ground rules, ordered by
   dependency, with exit criteria (mirror `02-phase-1-mvp.md`'s format).
3. Present for confirmation, then write `docs/plans/<nn>-<phase>.md` and slim
   the outline entry to a pointer.

## File mode — put a plan onto GitHub

1. Confirm the prior milestone is at/near exit (or the user explicitly wants
   parallel milestones).
2. Create the milestone (`gh api repos/{owner}/{repo}/milestones`), then one
   issue per work item: title `<ID> - <title>`, body = What + Done-when + Size
   + Depends + spec pointer to the plan file; label per phase (create the label
   if needed); assign the milestone.
3. Report the issue numbers and update the plan file's header with the
   milestone name.

## Triage mode — keep planning healthy

1. Read `PROGRESS.md`, the current plan file, and
   `gh issue list --milestone "<current>" --state all`.
2. Report: milestone progress (closed/open), anything **stale**,
   **under-specified** (weak done-when), **mis-ordered** (dependency problems),
   or **too big** (L-sized items not yet split). Flag plan-vs-issues drift
   (issues edited on GitHub but not reflected in the plan file, or vice versa).
3. Recommend the **next 3–5 items** with a one-line rationale each.
4. Offer to apply fixes — **ask before editing plans or issues**.

---

## Notes

- Never bulk-file future phases as issues — that's explicitly against process.
- Hand off implementation to **`/next-item`** (optionally `/next-item S-03`).
- User-action items (accounts, purchases, domain checks like OQ #6) are tagged
  `[user]` in plans — /pm can add them, but they're for Dan, not the assistant.
