# #716 / #1013 — what a streaming reply costs the window, and where it went

**Probe:** `spike/probes/716/typing-while-streaming.spec.ts` (copy into `e2e/`
to run; `PROBE_BACKLOG=980 PROBE_STREAM=1 PROBE_THROTTLE=4 npx playwright test e2e/typing-while-streaming.spec.ts`).
**Date:** 2026-10-06. **Outcome:** one cause measured and removed (about seven
eighths of the stalled time); one suspect cleared; the remainder measured and
left, with what it is known to be made of. **Then, the same day, a second cause
found in the remainder and removed — the rest of the stalled time at 4x and
nearly all of it at 6x. See "Second step".**

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

> ⚠️ **This section's headline was wrong — read "Second step" below first.** It
> is kept because the script breakdown in it is still true and is what is left.

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

## Second step, later the same day: the section above was wrong

**"There is no second single cause" was a conclusion drawn from an instrument
that could not see one.** The CPU profile samples script. It reported 2,291 ms
and described the rest as "not script at all: style, layout and paint for the
block that grew" — one clause, for what turned out to be twice the size of
everything it had itemised.

Two things were added to the probe before anything was changed:

- **`Performance.getMetrics` across the window** — the renderer's own
  cumulative accounting of script, style and layout. It is a continuous number.
  "Long tasks" counts only the part of a distribution that crosses 50 ms, and
  three identical runs on `main` read **971, 1,060 and 1,432 ms**, so the ±100 ms
  quoted above was optimistic; the layout figure moved by about 3% across the
  same runs.
- **`PROBE_TRACE=1`** — the engine's `devtools.timeline` events over the window,
  summed by name.

At 4x, 980 blocks, one reply streaming, on `main` after the first step:

| | ms of the 12 s window | |
|---|---|---|
| `Layout` | **4,417** | 237 of them, ~18 ms each — with **38 dirty objects of 1,296** |
| script, all of it | ~2,000 | the whole of the table in the section above |
| `IntersectionObserverController::computeIntersections` | 1,534 | the engine's own visibility watch |
| `Commit` | 1,298 | |
| `PrePaint` | 1,013 | |
| `Paint` | 815 | |

Thirty-eight dirty objects and eighteen milliseconds. The layout is not doing
much work; it is visiting a great deal. Since #740 every block is
`content-visibility: auto` on its own measured height, and that makes an
off-screen block cheap, not free: the engine keeps a visibility watch on each
such element and walks each one in layout, pre-paint and commit. There were 942
of them.

### Asked of the live DOM before writing anything

`PROBE_EVAL` runs a script in the page once the conversation is loaded, so a
"what would it cost if" needs no rebuild. Three, at 4x:

| | long tasks | stalled | frames | layout | key → paint p95 |
|---|---|---|---|---|---|
| `main` | 16–27 | 950–1,700 ms | 420–530 | 4,400 ms | 88–104 ms |
| all but the last 60 blocks `display: none` — **the floor** | 0 | 0 | ~785 | 1,430 ms | 56–64 ms |
| the same blocks in **plain** wrappers of 40 | 5–11 | 310–660 ms | ~600 | 3,600 ms | 88 ms |
| the same blocks in wrappers of 40 that are **themselves skipped** | 0 | 0 | ~785 | 1,390 ms | 56–64 ms |

A skipped wrapper reaches the floor. A plain one buys a fraction, so it is not
the number of siblings the container has that costs — it is the number of
skipped elements the engine can see, and a skipped group hides its forty.

(An earlier attempt at "rendering blocks in memoised groups", recorded above as
moving nothing, grouped them for React and left the DOM flat. It could not have
found this.)

### What shipped

Blocks sit in group elements keyed by `Math.floor(seq / 40)`, and
`useFeedSkipping` measures and skips the groups exactly as it does blocks. By
sequence number rather than position so that an eviction at the 1,000-block cap
never moves a block between parents. The last group — the one still being
written to — is measured and never skipped. A group whose blocks change while
it is skipped (eviction, the verbosity filter, a find-reveal), or that has just
stopped being the open one, is forgotten, rendered once and measured again.

The same probe against the real code, three runs each:

| | long tasks | stalled, of 12,000 ms | frames | layout | key → paint p95 |
|---|---|---|---|---|---|
| **4x** before | 16–27 | 950–1,700 | 420–530 | ~4,400 | 88–104 ms |
| **4x** after | **0–1** | **0–79** | **~748** | ~1,360 | **56–64 ms** |
| **6x** before | 66–70 | 5,470–5,940 | 183–212 | ~5,300 | 144–200 ms |
| **6x** after | **0–2** | **0–124** | **556–630** | ~2,150 | **80–96 ms** |

**And at the cap**, which the runs above never reach (`PROBE_BACKLOG=1000
PROBE_NEW=500`: a new block every half second, each one evicting the oldest, so
the first group is forgotten and re-measured every time — the steady state of a
long session). 4x, three runs each:

| | long tasks | stalled | frames | key → paint p95 | scroll height against fully laid out |
|---|---|---|---|---|---|
| before | 38–40 | 3,127–3,312 ms | 344–354 | 144–152 ms | −5 px of 101,168 |
| after | 0–1 | 0–66 ms | 708–712 | 64–72 ms | −1 px of 101,168 |

The probe now reads the scroll height both ways at the end of every run, the
way `e2e/feed-skipping.spec.ts` does.

**One conversation replacing another** needed a fix of its own, found in review:
both count from the same first sequence number, so React keeps the same elements
under the same keys and nothing reports that every stored height is now about
something else. It was true of blocks since #740; a group would have carried
forty times the error. The hook now takes a counter that `FeedView` bumps when
the list is replaced outright, and starts again from nothing.

The 4x "after" row is the floor measured above, and it is also what an IDLE
long conversation measured in the first table (88 ms key → paint, 746 frames):
at this throttle a streaming reply in a thousand-block conversation now costs
typing nothing that the probe can see.

### What is left

Script, and only script: ~2,000 ms of the window at 4x and ~3,400 at 6x, the
table in "What is left" above, unchanged by this step. The three things it
points at were not done. They are now the largest thing in the window rather
than a third of what remained, and at 6x the frame count (556–630 of ~750) says
there is still something to have. Measure them against `main thread busy` and
the script figure, not against long tasks, of which there are none left to
count.

## Third step, 2026-10-07: a reply cost more the longer it got

After the second step the one case that still stalled was a long reply on a
slow machine. The probe gained `PROBE_START` (the reply is already N characters
long when the window opens, and grows at the ordinary 240 characters a second)
because the earlier way of getting a long reply, `PROBE_STEP=67`, types five
times faster than any model and finishes a paragraph on nearly every chunk.
`PROBE_FLAGGED=1 PROBE_PARAS=1` throughout: the block carries `streaming: true`
as a real partial does, and is prose in ~330-character paragraphs.

**Two causes. The first was not on anybody's list.**

1. **React 19 compares `dangerouslySetInnerHTML` by the object, not by the
   string in it.** A fresh `{ __html }` holding identical text is a changed
   prop and the element's `innerHTML` is assigned again — the whole subtree
   torn down, rebuilt and laid out. `<Markdown>` built that object inline on
   every render, and a streaming block renders TWICE per chunk (the text
   arrives; then the frame `useCoalesced` owes fires), so the reply's DOM was
   being rebuilt twice per chunk, once for nothing. Found with a
   `MutationObserver` planted by `PROBE_EVAL` after a first attempt at the fix
   below moved script and left layout exactly where it was: **1,899 writes to
   settled pieces in a 12 s window in which none of them had changed.** With
   the object held still: 0.
2. **The whole reply was parsed, sanitised and replaced on every chunk** — step
   1 of the list further up. Now the reply is cut where it has settled (the
   start of its last top-level block, as the lexer reports it), each settled
   stretch is rendered once, and only the tail is re-rendered.

**How these were taken, because it changed half-way through.** The first
before/after was sequential — three runs of one build, then three of the other
— and a .NET build started on the machine between them; the same code read
3,100 ms of script in one batch and 4,200 in the next. So the two builds are now
kept side by side and the probe ALTERNATES between them, one run each, so both
see the same machine. Everything below is from alternating runs of the code that
shipped. The machine was not quiet (one "after" run at 6x is plainly a disturbed
one and is left in); the pairs are what to read.

A 13,000-character reply still growing. 6x, four pairs:

| pair | | long tasks | stalled, of 12,000 ms | frames | script | layout | key → paint p50 |
|---|---|---|---|---|---|---|---|
| 1 | before | 20 | 1,310 | 307 | 3,859 | 3,601 | 96 ms |
| | after | 4 | 225 | 690 | 3,392 | 1,707 | 72 ms |
| 2 | before | 18 | 1,088 | 240 | 3,959 | 3,481 | 80 ms |
| | after | 10 | 643 | 506 | 4,143 | 1,986 | 64 ms |
| 3 | before | 21 | 1,403 | 256 | 3,796 | 3,599 | 88 ms |
| | after | 17 | 1,091 | 324 | 4,466 | 2,242 | 88 ms |
| 4 | before | 9 | 602 | 272 | 4,046 | 3,456 | 80 ms |
| | after | 2 | 123 | 649 | 3,562 | 1,854 | 56 ms |

Frames are up in every pair, by 1.3x in the disturbed one and 2.1–2.4x in the
others. **Layout is the steady number: 3,456–3,601 ms before, 1,707–2,242
after**, down by 38–53%. Script moves with the machine more than with the
change.

4x, two pairs: main thread busy 10,595–11,029 ms before and 8,362–8,528 after;
layout 2,768–2,878 before and 1,234–1,279 after. Nothing stalls at 4x on either
side, so the saving there is headroom, not something a person would see.

**How much is each half?** One sequential batch on a quiet machine, 6x, with
the prop object held still and NO pieces: 592–610 frames and ~2,430 ms of
layout, against 358–387 and ~3,510 before it. So the object alone is most of
the frames; the pieces are the rest of the layout and all of the parse.

**A review found the first rule for "settled" was wrong**, and the fix cost a
little. "Every block but the last is finished" is false when the last line has
not finished arriving: `marked` accepts end of input where a newline would go,
so `see the fix in\n#` is a paragraph and a HEADING for one frame and one
paragraph the next. Only whole lines are evidence now. On its own that left the
tail two blocks long (the finished one and the one arriving), so a paragraph
with a blank line after it — which nothing can join — settles at once.

An ordinary reply (growing from nothing to ~2,900 characters) pays the same
double write. These are sequential and from the first version of the change,
and are here for the layout column only:

| | frames | layout | main thread busy |
|---|---|---|---|
| 6x before | 530–569 | ~2,940 | ~11,960 |
| 6x after | 571–694 | ~1,970 | ~11,020 |
| 4x before | 746–749 | ~2,045 | ~8,830 |
| 4x after | 749–752 | ~1,225 | ~7,295 |

**The earlier tables understate what `main` cost**, for the same reason: they
were taken without `PROBE_FLAGGED`, so the probe's block was a finished one that
kept changing — no coalescing, one render per chunk, one write. A real partial
is flagged. Compare the 4x "after" row of the second step (layout ~1,360) with
the 4x "before" row here (~2,045): same code, the flag is the difference.

**What it overturns.** `markdown.tsx` recorded, from #635, that the whole
pipeline costs 3.55 ms on a 20,000-character block and that "re-parsing only a
suffix would mean a second notion of what a document is". The number is right
and it is the parse; it did not count the DOM being replaced, which is where the
time was. The fear is kept: the cut is at block boundaries the lexer itself
reports, a reply containing a link definition, raw HTML or a carriage return is
not cut at all, every piece goes through the same parse → sanitise → decorate
calls, pieces are separate elements and are never joined as strings, and the
finished reply is rendered whole exactly as before. `markdown-settled.test.tsx`
holds the picture equal to the whole render at every length of a reply that has
one of every block construct in it.

**Not looked at:** other surfaces that hand React a fresh `{ __html }` per
render. The feed's finished blocks are memoised and do not re-render; the
document viewer and the update dialog were not measured.

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
