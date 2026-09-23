# E21 / #923 — what E21's own instrument costs

**Measured 2026-09-23** on the **dev desktop** (i9-13900K, 24c/32t, 64 GB,
Windows 11), in the real app, in a real Chromium renderer.
Probe: `spike/probes/923/perf-cost.spec.ts` (copy into `e2e/`, `npm run build`,
`npx playwright test e2e/perf-cost.spec.ts --reporter=list`).

## The question

#923's done-when says the always-on tier must record **"with no measurable cost
— shown with a before/after number, not asserted"**, and the owner's rule 2 says
the detailed tier must be genuinely absent when off. The second half is pinned
by a test (`perf.absent.test.ts`). This is the first half, and the number the
owner actually cares about behind it: *if I switch the detailed tier on for a
working day, have I made the thing I am measuring slower?*

## Method, and the two ways the first draft got it wrong

400 synthetic keystrokes per phase, dispatched **in-page** (a CDP round trip per
key is larger than the thing being measured), one animation frame between each
because typing is paced by paints.

Two corrections were needed before the numbers meant anything, and both are
worth recording because both produced confident, wrong answers first:

1. **Wall clock measures vsync, not work.** Every phase came out at 16.68–16.70
   ms/key — 60 Hz, to three decimal places, regardless of what was switched on.
   Any cost under one frame is invisible that way, which is precisely the range
   in question. The probe now sums JS time *inside* the dispatch and excludes
   the frame waits.
2. **Straight "off then on" ordering reports warm-up as the instrument's cost.**
   Run in sequence, the last phase was the fastest and tier 2 appeared to make
   typing *faster* than no tier 2 at all. Phases are now **interleaved** over 5
   rounds and reported as min and median.

A third, smaller one: reading `scrollHeight` 20,000 times in a row prices a
property lookup, not a forced layout — the engine answers every read after the
first from a cached layout. The loop now invalidates style on a throwaway node
between reads, which is what makes 7.5 µs a *forced layout* rather than a
getter call.

## The numbers

400 keys × 5 interleaved rounds, empty conversation:

| | per-key JS work (median) | one forced layout read (median) |
|---|---|---|
| capture **OFF** — what ships | **0.688 ms** | **7550 ns** |
| capture **ON** — tier 2 loaded | **0.660 ms** | **7500 ns** |
| one extra always-on observer pair | 0.575 ms | 7150 ns |

## What this says

- **Tier 2's cost is below this machine's noise floor.** ON measured nominally
  *faster* than OFF on both metrics, which is not a result — it is the
  measurement saying the difference is smaller than the run-to-run spread
  (~0.05 ms/key). The honest claim is "under 0.05 ms per keystroke", not zero.
- **The layout-read wrapper is lost inside the thing it wraps.** A forced layout
  costs ~7.5 µs; the patched accessor adds a function call and one boolean test,
  and the difference does not survive five rounds. That matters because the
  wrapper is tier 2's one app-wide residual tax — it is installed for as long as
  the switch is on, not per keystroke.
- **The always-on tier is free within the same bound.** Adding a *second*,
  identical `longtask` + `event` observer pair beside the app's own changed
  nothing measurable. This over-states tier 1's cost on purpose: tier 1 cannot
  be switched off from inside the page, so the marginal cost of one more of
  exactly the same thing is the closest honest proxy. Chromium collects long
  tasks and event timings whether or not anyone observes them; observing reads
  a buffer the engine already filled.

## What this does NOT say

**This is the dev desktop, on an empty conversation, and that is the machine and
the workload E21 exists because we stopped trusting.** 0.66 ms/key here is not
in the same world as the 152 ms/key #740 measured at 400 turns under a throttle,
and neither number came from the work laptop. The instrument being free *here*
is necessary, not sufficient.

**It does not cover tier 2's sampling callback.** `workMs` sums time *inside*
the keystroke dispatch and excludes the frame waits — but tier 2's per-sample
work (`closest`, `getAttribute`, the long-task correlation, the push) all runs
in the rAF/timeout during exactly those excluded waits. The conclusion is very
likely still right, since that work is a handful of DOM reads on one element,
but this probe does not price it and should not be read as if it did.

**It does not cover popped-out sessions, because nothing does.** Tier 2 attaches
to the main window's document; a popout is its own document with its own
`Element.prototype`, so a popped-out composer records nothing at all. Recorded
here and in the manual rather than silently, because "no samples" is
indistinguishable from "did not type".

**P2-E21-02 is the real measurement**: the owner switches the capture on, works
a normal day on the laptop with three or more sessions, and attaches
`performance-capture.jsonl`. If tier 2 turns out to cost something visible
*there*, the file itself will say so — every keystroke sample carries the
conversation size it was taken against, which is the variable this probe holds
at zero.
