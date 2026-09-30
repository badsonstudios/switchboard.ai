# #981 — the composer's offer, and why the box overshot it

**Probe:** `spike/probes/981/probe-composer-room.spec.ts` (Playwright, real app,
Windows 11, 2026-09-30). **Stimulus:** the `#716` geometry — a long draft in the
composer, the window grown until the PANEL rather than the twelve-line cap is
what stops the box, then one `Bash` permission docked.

The issue offered three candidates for the ~49px overshoot: a double-count in
`roomForBox`'s chrome term, something downstream taking `max(room, line
minimum)`, or the offer never being applied at all. **All three are wrong.** The
arithmetic is right and the offer is applied exactly; what is wrong is the state
the world is in when the measurement runs.

## What the probe measured

Panel 298px, verbosity strip 21px, one `Bash` approval bar, composer at the
bottom.

| | before the bar | with the bar (settled) |
|---|---|---|
| approval bar | — | **122** |
| composer root | 216 | 116 |
| textarea `max-block-size` | 162px | **62px** |
| textarea client | 176 | 76 |
| conversation | 62 | **12** |

62px of cap means `roomForBox` returned an offer of ~78 — and 78 is only
reachable if the docked siblings summed to **121**, i.e. the bar measured
**100**, not the 122 it settles at.

## The cause: the bar is squeezed by the box it is being measured against

The approval bar is `flex: 0 1 auto` with `minBlockSize: 0` — deliberately, from
#972, so a tall body cannot push Allow and Deny off the column. That makes its
height a **function of what the composer is currently taking**. Replayed in the
same run, by forcing the box back to each height and re-reading the siblings:

| textarea `max-block-size` | approval bar `offsetHeight` | its `scrollHeight` |
|---|---|---|
| 162px (as it was before the bar docked) | **50** | 100 |
| 40px (as it settles after the fix) | 122 | 120 |
| 0px (the box at its minimum) | **122** | 120 |

So the sequence is a one-way ratchet:

1. the bar docks while the box is still tall → the bar is squeezed to ~50–100px;
2. `roomForBox` reads that squeezed height, subtracts it, and offers the box a
   cap computed as though the bar were ~72px shorter than it is about to be;
3. the box honours the offer and shrinks;
4. the bar springs back into the room the box just let go of;
5. the conversation — the only `flex: 1` item left — pays for both. 12px against
   a floor of 60.

`roomForBox`'s own docblock said the box no longer needed collapsing before a
measurement, and `remeasure`'s dedupe said "nothing `remeasure` reads depends on
what it writes". The first is true of the CHROME term and false of the SIBLING
term; the second was simply false, and this is the bug it permitted.

## `scrollHeight` was tried as the cheap fix and rejected on the numbers

Reading each sibling's `scrollHeight` instead of `offsetHeight` would avoid
mutating anything. It does not work: the same bar reports **100 squeezed and 120
settled**, so it is not the natural height either — it moves for the same reason
`offsetHeight` does, only less.

**What does work is collapsing the box for the sibling measurement.** It is the
only state in which "what can this panel spare" has an answer that does not
depend on the answer, and the table above shows 0px and 40px agreeing at 122.

## The second door, also measured

"Deny with feedback" opens an objection field **inside the bar that is already
docked**: 122px → **194px**. `dockedChrome` does not change (the same bars are
docked), the box keeps its width, the panel keeps its height, the options row
keeps its wrap — so all four signals the composer watched were silent, and the
cap stayed stale. With the docked siblings observed, the box gives its room back
(54 → 32, one line).

At that size the floor is **unreachable and correctly so**: panel 298, grown bar
194, composer minimum 72 — 60px for the conversation does not exist. The box
goes to one line, Allow stays on screen. That is `MIN_FEED_PX`'s documented
fail-open, and it is the same trade `approval-diff.spec.ts` asserts.
