# Phases 2–4 — Outlines

Deliberately thin: detailed work items get written just-in-time when the prior
phase nears exit (see 00-process.md). The authoritative feature list per phase
is DESIGN.md §8; this file only adds sequencing intent and planning notes.
Bulk-filing issues from this file is explicitly against process.

## Phase 2 — The Switchboard
*Theme: sessions become aware of each other; attention system matures.*

**Broken out → `docs/plans/04-phase-2-switchboard.md`** (epics E7–E14;
milestone "Phase 2 - The Switchboard", opened 2026-07-20; reconciled against
DESIGN.md §8 on 2026-07-21 — the original E7–E11 break-out had dropped several
§8 items, restored as E13/E14 + additions, with three items demoted to
Phase 3). Original planning notes retained below.

Planning notes for when this gets broken out:
- **Approval surfaces v1 is the crown jewel** of the phase (owner's #1 pain) —
  sequence it early, not last; it depends only on the S-03 verdict + Monaco.
- Attention-driven layout + presentation ladder next (the 7-8 session
  experience), then Session Bus + context transfer (the signature features),
  then dispatch v1, pop-outs/multi-monitor, fleet snapshots.
- Feed view v1 and notifications v2 can interleave anywhere.
- Empirical spike embedded in this phase: OQ #9 (merge-conflict endgame) wants
  its 7-8-real-branches experiment once parallel worktree use is real.

## Phase 3 — The IDE
*Theme: review, safety, and fleet-level surfaces.*

Planning notes:
- **Inherited from Phase 2** (2026-07-21 reconciliation, now in DESIGN.md §8
  Phase 3): watcher windows + undercard tray + attention bubbling (§5.6,
  §5.24) · tray mode + session archive v1 (§5.25) · fleet snapshots + layout
  DSL v1 + restore confirm gate (§7, OQ #14/#15). Include them when this phase
  gets broken out.
- Checkpoint & rollback v1 (§5.28) should land BEFORE dispatch v2's
  auto-dispatch loops — autonomy without seatbelts inverts the risk order.
- Cross-session review dashboard + mission-control dashboard share data
  plumbing with ClaudeMon integration — plan those three together.
- ClaudeMon read (OQ #8) must happen before this phase's planning; ideally far
  earlier.

## Phase 4 — The Ecosystem
*Theme: beyond Claude, beyond the desktop, beyond first-party.*

Planning notes:
- Adapter order by likely demand: Codex → Gemini → Aider → generic.
- Plugin API alpha gate: only after 2-3 dissimilar internal consumers exist on
  the seams (§5.23) — check the registry's actual consumer list before
  scheduling.
- Mobile companion's security policy questions (OQ #12) need answers before its
  first line of code.
- Packaging/public-release items trigger the name check (OQ #6) as a hard
  prerequisite.
