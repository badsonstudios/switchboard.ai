# 1130 — what folding exploration calls costs a streaming reply

**Question.** #1130's acceptance 4: "Measured before/after on the #716 probe
shows no regression (ideally an improvement)."

**Method.** `spike/probes/716/typing-while-streaming.spec.ts`, unchanged: a
backlog of 980 real blocks from this machine's transcripts, one reply streaming
every 50 ms, a key typed every 100 ms, 4x CPU throttle, 12 s. Two builds of the
same tree, differing only in `FeedView.tsx` (committed vs. with the fold), kept
as two copies of `out/` and **swapped run by run** — before, after, before,
after — because this desktop builds other projects in the background and two
sequential batches would measure the machine.

**Result (2026-10-08, four pairs).**

| | before | after |
|---|---|---|
| long tasks | 0, 0, 0, 0 | 0, 0, 0, 0 |
| frames in 12 s | 749, 755, 753, 755 | 753, 751, 753, 750 |
| p95 frame gap | 17 ms, all four | 17 ms, all four |
| layout | 1268, 1270, 1288, 1290 ms | 1275, 1242, 1236, 1263 ms |
| style | 342, 333, 330, 363 ms | 334, 326, 318, 324 ms |
| script | 1919, 1841, 1902, 1924 ms | 1997, 2035, 1985, 1987 ms |
| key to paint p50 / p95 | 40-48 / 48-56 ms | 40-48 / 48-56 ms |

**Reading it.**

- **No regression in anything the user feels**: no long tasks either way, the
  same frame count, the same key-to-paint (it is quantised to the 8 ms frame
  step at this throttle, so 40 and 48 are one frame apart and both builds show
  both).
- **Script time is up about 5 %** (mean 1897 -> 2001 ms over 12 s, at 4x). That
  is the fold pass: one more walk over the rendered list on every render, the
  same shape and size as `agentRunHeads` and `groupBySeq` beside it. About
  0.1 ms per streamed chunk unthrottled.
- **Layout and style are down slightly** (means 1279 -> 1254 and 342 -> 326 ms):
  fewer rows exist.
- **It is not the improvement the ticket hoped for, on this backlog.** The
  conversation was 1.4 % shorter folded (`scrollHeight` 101,262 -> 99,816). The
  probe's backlog is the newest 980 blocks of real sessions, and off-screen
  blocks were already free since #716's group skipping, so removing them saves
  almost nothing. The saving a fold makes is on screen: twenty rows that are
  one.

**Not measured.** A conversation that is mostly exploration (the owner's
screenshot is twenty calls in a row), where the on-screen rows are the ones
folded away. The probe's backlog cannot be steered to that shape without
changing what it measures.
