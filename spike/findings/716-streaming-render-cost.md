# #716 / #1013 — what a streaming reply costs the window, and where it went

**Probe:** `spike/probes/716/typing-while-streaming.spec.ts` (copy into `e2e/`
to run; `PROBE_BACKLOG=980 PROBE_STREAM=1 PROBE_THROTTLE=4 npx playwright test e2e/typing-while-streaming.spec.ts`).
**Date:** 2026-10-06. **Outcome:** one cause measured and removed (about seven
eighths of the stalled time); one suspect cleared; the remainder measured and
left, with what it is known to be made of.

## What was known

The owner, 2026-10-05, on the current build and the **desktop**: *"if I have a
session going and Claude is busy, typing into the prompt can be sluggish."*

#1062 lists what had never been measured: *"What ONE feed render costs in the
renderer at 400+ turns. The probe counts messages in node; it cannot say what
fraction of a core 1,335 renders is."* This is that number.

## What the probe does

The real app, one session. A conversation of REAL blocks (the app's own
`blocksFrom` over transcripts on this machine) is loaded, then one reply streams
into it as a block that grows by ~12 characters every 50 ms — 60 tokens a
second through `STREAM_COALESCE_MS`, which is what the shipped code lets
through — while a key is typed into the prompt box every 100 ms, for 12 s.

Read off the page's own instruments (Event Timing, long tasks, frame gaps).
Nothing of ours is on the keystroke path. CPU throttle is CDP's
`Emulation.setCPUThrottlingRate`, the proxy for the laptop this project has
used since #716.

## Measured

| | long tasks | stalled, of 12,000 ms | frames drawn | key → paint p95 | wait before the key is even handled, p95 |
|---|---|---|---|---|---|
| **1x**, 980 blocks, streaming | 0 | 0 | 753 | 64 ms | 6 ms |
| **4x**, 980 blocks, nothing streaming | 0 | 0 | 746 | 88 ms | 6 ms |
| **4x**, 100 blocks, streaming | 0 | 0 | 752 | 72 ms | 5 ms |
| **4x**, 980 blocks, streaming — **before** | **86** | **7,648** | **154** | 152 ms | 48 ms |
| **4x**, 980 blocks, streaming — **after** | **16** | **931** | **551** | 104 ms | 22 ms |
| 6x, 980 blocks, streaming — after | 70 | 5,914 | 213 | 192 ms | 37 ms |

Three things in that table:

1. **It is invisible on this desktop unthrottled.** Row one. That is why it
   kept being reported from the laptop and not reproduced here.
2. **The cost of one streamed chunk scales with the length of the
   conversation.** Same reply, same throttle: nothing at 100 blocks, 64% of the
   window stalled at 980.
3. **Idle, a long conversation costs nothing.** So it is not the conversation
   being long; it is what a chunk does to a long conversation.

## The cause

`FeedView` holds the conversation as one array. Every streamed chunk is a
`setBlocks`, and the component then rendered **every block** — the `Block`
component was not memoised — to change one. Each `Block` resolves its renderer
and builds a fresh element tree, so React also had to walk into all of them.

`upsertBlock` copies the array and keeps every untouched element's identity, so
`React.memo` on `Block` is enough: 979 of 980 are skipped per chunk.

One existing behaviour depended on blocks NOT being memoised: #463's
self-healing. A block whose renderer throws is retried when its error boundary
is handed new children, which a skipped render never does. The boundary now
reports when it is mid-retry (`onStreak`) and the skip stands down for that one
block for exactly that long. `FeedView.boundary.test.tsx` holds both halves.

## Tried, and did not move it

- **Memoising the composer** as well (it is a child of `FeedView`, so it too
  re-rendered per chunk): 958 → 1,019 and 1,114 ms across two runs. Noise.
  Not shipped.
- **Rendering blocks in memoised groups** keyed by a stable `seq` range, so a
  chunk compares a couple of dozen groups instead of a thousand blocks: 931 →
  816 ms at 4x, 5,914 → 6,182 ms at 6x. Noise in both directions. Not shipped
  — and it was the step an earlier draft of this note recommended, on the
  strength of a split that the profile below does not support.

Run-to-run noise on the "stalled" figure is about ±100 ms at 4x, so nothing
smaller than that can be told apart with this metric.

## What is left, and what it is made of

At 4x: 16 long tasks, 931 ms. At 6x it is still 5.9 s, so a machine slower
than the 4x proxy will still feel it. **There is no second single cause.**

A sampling CPU profile of the renderer over the same window (`PROBE_PROFILE=1`,
against an unminified build), after the fix — 2,291 ms of script in the 12 s
window, by self time:

| | ms | what it is |
|---|---|---|
| the tail pin's `reconcile` and `pin` | 236 + 73 | reading `clientHeight` / `scrollHeight` after a chunk landed, which FORCES the layout for the block that grew — so this is largely layout billed to the caller |
| React, summed across its internals | ~450 | `reconcileChildrenArray`, `createWorkInProgress`, `updateMemoComponent`, `setProp`, context propagation, … — the render that still happens: `FeedView`, the composer, a thousand skipped children |
| Markdown for the streaming block | ~200 | parse, `DOMParser`, sanitize, decorate — the whole growing text, every chunk |
| i18n lookups | ~120 | `t()` calls in components that re-render per chunk |
| building the list's elements | 78 | the `visibleBlocks.map` callback — which is why grouping did nothing |
| `upsertBlock` | 42 | two scans and a copy per chunk |

The rest of the window's main-thread time is not script at all: style, layout
and paint for the block that grew.

Holding the reply's text CONSTANT (a new object each 50 ms, identical contents
— React re-renders, the page does not change) leaves 378–457 ms of long tasks
at 4x, against 708–931 ms with it growing. So about half of what remains is
script on a render that changes nothing, and about half is the page changing.

What that points at, in the order the numbers suggest, none of it done here:

1. **Do not re-parse the whole reply on every chunk.** It is the one cost that
   grows with the length of the REPLY as well as being paid per chunk; #1062
   (send only the new text) is its upstream half.
2. **Let the tail pin stop forcing layout** — observe the size change it
   already subscribes to rather than reading geometry in the same frame.
3. **Move the block list's state below `FeedView`**, so a chunk does not
   re-render the composer and the chrome around the conversation at all.

Each is worth something like 100–300 ms of a 12 s window at 4x. None is the
next 8x.

## What this probe cannot say

- **One session.** #1013 is eight. Each visible conversation pays this
  separately, so the saving should multiply, but that is an inference.
- **Synthetic stream.** One prose block growing. A real turn interleaves tool
  calls, results landing late and thinking blocks.
- **The throttle is a proxy.** It slows JavaScript and layout alike; a real
  laptop with an endpoint-security agent taxes process spawns and file reads,
  which this does not model at all.
- #1062 (send only the new text) is untouched and still the measured fix for
  bytes on the wire.
