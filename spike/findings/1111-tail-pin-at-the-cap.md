# #1111 — why a long session stopped following its tail

**Probe:** `spike/probes/1111/replay-and-fuzz.spec.ts` (copy into `e2e/` to run;
`PROBE_SEED=3 PROBE_FUZZ=gutter PROBE_SAMPLER=0 npx playwright test e2e/replay-and-fuzz.spec.ts`).
**Date:** 2026-10-06. **Outcome:** reproduced before anything was changed, one
cause measured, fixed, and the same probe run again on the fix.

## What was known

The owner, on v0.8.113: *"The session window is not scrolling down all the time.
I thought we fixed that."* Round one (#967, PR #983) and the test fix after it
(#1079) were both reasoned from the code, and `feed-tail-pin.spec.ts` said of
its own #967 case that it could not tell the fix from its absence. The issue
listed three leads: the 50 ms re-emit hold (#1063), relayout (#740), and the
deliberate unpin paths.

## What the probe does

It replays REAL blocks — derived from transcripts on this machine by the app's
own `blocksFrom` — into a running app over the real `sessions:feedBlock`
channel, paced over ticks: prose arriving as growing partials 50 ms apart, tool
results landing up to 1.5 s after their call, bursts and pauses. 980 blocks are
loaded first, then ~170–260 arrive live.

A seeded fuzzer does things a person does that are NOT scrolling up. So any
appearance of **↓ Jump to latest** is the feed deciding the user left when they
did not. A second check watches for the other failure the issue named — pinned,
but sitting short of the tail.

## What it measured, before the fix

| input while streaming | conversation | inputs | false unpins |
|---|---|---|---|
| none | at the 1,000-block cap | — | **0** |
| clicks on empty gutter, nothing reading geometry | at the cap | 44 clicks | **23** |
| same, second seed | at the cap | 74 clicks | **28** |
| clicks on empty gutter | ~470 blocks | 169 clicks | **0** |
| same, second seed | ~470 blocks | 246 clicks | **0** |
| wheel DOWN only | at the cap | 109 wheels | **11** |
| clicks and expander toggles | at the cap | 22 clicks | **22** |

"Pinned but not at the tail" never lasted longer than 292 ms in any run. This
bug is an honest unpin — the chip appears — not a scroll write failing to land.

The click counts in the failing rows are low because each unpin costs the
probe 1.4 s to notice and press the chip; nearly every click that landed while
blocks were arriving unpinned.

## The cause

`upsertBlock` caps the view at 1,000 blocks. In a long session every new block
therefore EVICTS the oldest one from the top. Chrome's scroll anchoring holds
what is on screen still by lowering `scrollTop` by the evicted block's height.
One of the recorded events:

    scrollTop 99965 -> 99887   (-78: the evicted block)
    scrollHeight 100413 -> 100387
    distance from the tail: 53px, the block that had just arrived

Nothing moved on screen. But the number went down, and #983's rule read any
negative delta inside the 500 ms window after a gesture as "the user scrolled
up". `onPointerDown` and `onWheel` both open that window.

The scroll event has to be dispatched before the frame's own pin runs, which
needs a layout between the evicting commit and the next frame. A real pointer
event does that by itself — it hit-tests — so the click that opens the window
is also what lets the event through.

All three leads on the issue are cleared by the first row: with no input, the
50 ms hold, relayout and everything else produce zero unpins.

**Why two rounds missed it:** it needs 1,000 blocks. `feed-tail-pin.spec.ts`
has about 260.

## The fix, and the same probe after it

A negative delta is only believed when the gesture behind it is one that can
move the view up (`FeedGesture` / `canScrollUp` in `lib/feed-pin.ts`).

| input while streaming | conversation | inputs | false unpins |
|---|---|---|---|
| clicks on empty gutter | at the cap | 159 clicks | **0** |
| same, second seed | at the cap | 209 clicks | **0** |
| wheel DOWN only | at the cap | 98 wheels | **0** |
| everything (clicks, expanders, wheel down, modifiers, composer, resize) | at the cap | 71 actions | **0** |

## What is left

- **A drag with the button held, at the cap, can still be read as scrolling
  up** — selecting text while a long session streams. A drag genuinely can
  scroll, so it stays on the "can" side. Not measured; stated.
- **A wheel toward the top over something that scrolls by itself inside the
  conversation** is recorded as a wheel-up on the conversation too.
- The probe's 100 ms sampler reads geometry from a timer, which forces a layout
  between frames and is itself a way to provoke the bug. `PROBE_SAMPLER=0`
  turns it off; every number in the tables above that says "nothing reading
  geometry" was taken that way.
