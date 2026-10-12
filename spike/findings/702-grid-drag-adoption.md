# #702 — grid-drag group adoption: confirmed dead on every path, and removed

Measured 2026-10-12 on the desktop, in the real app with the fake CLI and a
real mouse. Probe: `spike/probes/702/grid-drag-adoption.spec.ts` (copy into
`e2e/`; the handler counts need `.claude/work_files/702-instrument.py`-style
counters in `SessionGrid.tsx`, which were added for the run and never
committed).

## The claim

E12-04: "membership follows the panel when the user drags it between dockview
groups in the grid". A listener on each card's `onDidGroupChange` looked its
panel up, read the tabs it now sat beside, and wrote the first neighbour's
persistent group onto the session (or `null` if the neighbours had none).

The ticket: that listener "looks dead", because dockview's `openPanel` sets a
panel's group, which fires the event, BEFORE it registers the panel in the
group, so the listener's `containerApi.getPanel(id)` answers `undefined`. Read
off dockview's source in August while fixing a popout bug; never run.

## Confirmed

Two sessions, one in a persistent group and one in none, in a column each.

| Gesture | Did the card move? | The session's group afterwards |
|---|---|---|
| The ungrouped tab dropped on the grouped session's tab | yes, one dockview group holds both | **still none** |
| ...then split off into a column of its own | yes | still none |
| The GROUPED tab dropped on the ungrouped session's tab | yes | **still its own group** |

And what the listener did, per way a card can change dockview group:

| Path | Times the event fired | Panel registered when it fired | Listener got past its lookup | Reached a decision |
|---|---|---|---|---|
| Two sessions opened, then the two-column layout (`openPanel`, `moveTo`) | 2 (both also stopped by a guard) | 0 | 0 | 0 |
| Real drag into another group | 1 | 0 | 0 | 0 |
| Real drag splitting off a new group | 1 | 0 | 0 | 0 |
| Real drag, grouped onto ungrouped | 1 | 0 | 0 | 0 |
| Pop out to its own window | 1 | 0 | 0 | 0 |
| Dock back in / stack / expand, from the palette | 0 in this run | n/a | n/a | n/a |

**Every time the event fired, the panel was not registered yet, and the
listener returned at its first line. It never once decided anything.** A
session's group has only ever been changed from the Sessions list (drag a
row, the menu, the keyboard), which is also the only way the manual
describes. `e2e/groups.spec.ts`'s E12-04 test drags a row in the list; nothing
ever tested the grid half.

(The last row is a gap in the probe, not a finding: those three commands did
not move a card in the state the probe had left, so no event fired to count.)

## Decision: removed, not repaired

The ticket asks for dead paths to be "removed or fixed deliberately". Removed:

- **Repaired, it erases groups.** Its rule is "take the first neighbour's
  group, or none". Dropping a grouped session's tab beside ungrouped tabs
  adopts none. Arranging cards is something people do all day, and nobody has
  ever lost a group to it, because this never worked. Turning it on now would
  be a new, destructive behaviour arriving as a "fix".
- **It is the wrong layer.** Where a card sits is presentation; which group a
  session belongs to is the user's own data. The codebase already says so in
  half a dozen places: `isMoving`, the dock-back arming, the rail-drop flag
  and the ladder guard all exist to stop this one listener reading the app's
  own moves as a user's drag, and `ladder.spec.ts` states the rule outright
  ("presentation must never write session data").
- **Nothing documented is lost.** The manual has never said a grid drag
  changes a group.

Removed: the listener and `adoptMembershipFromDockGroup` in `SessionGrid.tsx`,
and `pickAdoptedGroupId` (with its unit tests) in `lib/groups.ts`. The guards
stay; they also protect the popout listener. Their comments that described
"E12-04's adoption" as something that could fire were corrected where they
said so most directly.

Pinned by `e2e/grid-drag-keeps-group.spec.ts`: the three rows of the first
table, with a real mouse.

## If moving between groups from the grid is wanted

It should be a gesture that says so (a drop target that names the group, as
the Sessions list has), not a side effect of where a tab lands. DESIGN ("Move-between")
and the Phase 2 plan's E12-04 entry now say the grid half was never delivered
and is not planned as a side effect.
