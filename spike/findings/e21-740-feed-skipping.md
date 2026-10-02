# E21 / #740 — the feed can skip its own off-screen blocks, and the heights can be exact

**Probes:** `spike/probes/740/feed-relayout.spec.ts` (cost),
`spike/probes/740/feed-skipping-contract.spec.ts` (the promises skipping has to keep).
**Machine:** the dev desktop, Windows 11, Electron/Chromium **150.0.7871.114**.
**Conditions:** 4× CPU throttle via CDP `Emulation.setCPUThrottlingRate`, 40
keystrokes per row, a 600-character draft already in the composer, one key per
animation frame.

---

## 1. The headline: it works, and the number that reverted the first attempt is now zero

Both columns below come from the **same build, same run, same machine**. `shipped`
is the app with `useFeedSkipping` doing its job; `feature stripped` is the same
app with the two inline properties removed by the probe immediately beforehand —
a true A/B rather than a comparison against a remembered number.

**400 blocks:**

| | layout ms/key | frame ms/key | long tasks | `scrollHeight` error |
|---|---|---|---|---|
| **shipped (the fix)** | **7.30** | **16.60** | **0** | **+0.0%** |
| feature stripped (the before) | 28.50 | 43.30 | 3, totalling 157ms | +0.0% |
| feed removed entirely (the floor) | 1.70 | 16.60 | 0 | — |
| the reverted global `80px` guess | 7.30 | 17.90 | 1, totalling 85ms | **+140.8%** |

**60 blocks:** shipped 4.10 / 16.60; stripped 5.10 / 16.60; both exact.

Three things to read out of that table:

* **The frame is back inside its budget.** 43.3ms is two and a half frames — it
  is what "keystrokes buffer and then appear all at once" *is*. 16.6ms is one
  frame at 60Hz, i.e. the key echoes on the next paint.
* **The long tasks go to zero**, which is the same thing said by the instrument
  #1031 added.
* **The guess and the measurement cost the same** (7.30 vs 7.30) and differ only
  in being right. The first attempt was reverted for the +140.8%, not for its
  speed, and nothing about the speed had to be given up to fix it.

## 2. Width is the thing that makes a measured height a lie

A height is only true at the width it was measured at. Narrowing the pane
**954px → 525px** with prose in the blocks:

| | `scrollHeight` | truth at that width | error |
|---|---|---|---|
| stored heights kept | 12,461 | 17,177 | **−27.5%** |
| heights dropped, one real layout, re-measured | 17,177 | 17,177 | **0.0%** |

So the implementation throws the whole map away on a width change rather than
trying to be clever about it. The user pays nothing new: a resize already
re-lays-out the feed, and that is the layout being re-spent.

⚠️ **Re-subscribing the observer is part of the remedy and is easy to leave
out.** A block whose height happens to be unchanged at the new width never fires
a resize, so without a fresh first observation it would sit unmeasured and
unskipped for ever — silently, with no error anywhere.

## 3. Scroll restore survives the skip

Parked mid-conversation at `scrollTop` 4,408 of 11,021, then switched the feed
from fully laid out to fully skipped:

| | before | after |
|---|---|---|
| `scrollTop` | 4,408 | 4,408 |
| block at the fold | seq 138 | seq 138 |
| `scrollHeight` | 11,021 | 11,021 |

This is the test the first attempt failed — Dan's own 2026-07-26 reading-position
bug, which on Linux CI restored a `scrollTop` of 2,189 where 1,640 was saved.

## 4. Engine support, read rather than assumed

Chromium 150.0.7871.114 has all of it: `content-visibility: auto`,
`contain-intrinsic-size` in both the bare and `auto <length>` forms,
`checkVisibility()`, and the `contentvisibilityautostatechange` event.

---

## What this cost to learn, which is the part worth keeping

**1. Reading a block's geometry UN-SKIPS it, so the obvious instrument destroys
what it is measuring.** Chromium performs a forced layout upgrade when script
queries geometry inside skipped content. Probe B had two independent witnesses —
`checkVisibility({ contentVisibilityAuto: true })` and "do this block's children
still have boxes" — and **both reported "0 of 342 skipped" in runs where
`scrollHeight` was unarguably standing on intrinsic sizes**, because both had
walked every block's rect before asking. The two probes contradicted each other
for four runs. This is now a load-bearing constraint on the implementation
rather than a curiosity: `use-feed-skipping.ts` never reads geometry at all, and
every height it has came from a `ResizeObserver` reporting a size the engine
computed for its own reasons.

**2. The first version of the cost probe measured the wrong thing and said the
bug was gone.** It timed JS inside the keystroke's dispatch and reported
2.6ms/key at 400 blocks — flat against the 2.0ms floor. But **#739 removed the
composer's forced synchronous layout**, which means that since #739 the relayout
a keystroke causes happens at *frame* time, outside the dispatch. The metric was
blind to exactly the cost the item is about. What replaced it: flush the pending
layout with one read and time the flush, plus the paced wall clock per frame.

**3. A probe that drives the feature it measures will measure its own
interference.** Once `useFeedSkipping` shipped, the cost probe's `normal` row
stopped meaning "as shipped" — its `clear()` strips exactly the two properties
the hook writes, and nothing puts them back until the next block arrives. The
`shipped` row that followed read `appCV: 0` beside an unchanged 26.4ms/key: the
probe had switched the fix off and then reported that the fix did nothing. The
`appCV` column exists so that is visible at a glance, and the warm-up run is
`shipped` for the same reason.

**4. Two of the contract probe's four questions were vacuous on the first run,
and both looked like answers.** Q2 seeded nine-character blocks and reported
that a 954 → 525 narrowing changes the content height by 0.0% — true, and
meaningless, because a one-line block does not rewrap at any width. Q3 asked to
park 40% of the way down a conversation, reported `parkedAt: 10638` of 11,021,
and nobody read the number: **the feed is tail-pinned**, so writing `scrollTop`
fires `onScroll`, the pin rule puts the view back at the bottom, and every
"mid-feed" answer was really about the bottom. Both now assert their own premise
— the fixture is prose that reflows, and a synthetic wheel event unpins the tail
before the park.

**5. A Playwright run whose frames are 1000ms long is an occluded window, not a
result.** One run of the cost probe came back with every `frame` column reading
1001.00 and took 8.3 minutes instead of 18 seconds: the window had been
backgrounded and `requestAnimationFrame` throttled to 1Hz. The *relative*
numbers survived it, which is the dangerous part — it would have been easy to
quote them.

---

## What is NOT settled

* **Everything here is Windows.** #740 says Windows-only green is not evidence,
  because the reverted attempt was green on Windows and red on Linux CI.
* **Paint containment comes with `content-visibility: auto` whether or not a
  block is skipped**, so anything in a feed renderer that paints outside its own
  box is clipped now. Nothing in the feed spec family found such a thing; that
  is absence of evidence from a suite that was not written to look for it.
* **The turn dividers and agent captions are siblings of the blocks**, not
  children, so they still lay out unconditionally — 400 of them at 400 turns.
  That is part of the 7.3ms residual against the 1.7ms floor, and it is the next
  thing to take if this is not enough on the owner's laptop.
