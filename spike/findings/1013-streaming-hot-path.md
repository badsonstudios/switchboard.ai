# #1013 — where the renderer's core goes while sessions stream

**Probe:** `spike/probes/1013/probe.test.ts`
(`npx vitest run --config spike/probes/1013/vitest.probe.config.ts`).
**Date:** 2026-10-03. **Outcome:** one cause measured and reduced 3x; one
suspect cleared; the larger fix named and left as a follow-up.

## What was known

#1013's capture says WHERE: with 8 sessions open, the renderer sits at 0.7–1.0
cores whenever several stream at once and UI lag reaches 850–2,700ms; idle, it
is 0.1 cores and 15ms. It does not say WHAT. E23 was marked "blocked on the
owner's laptop capture" — #1013 is a capture, so the gate was already open.

## What the code does per token

`StreamFeed` handles `content_block_delta` by appending the piece to the
block's text and calling `FeedBuffer.update`, which fired unconditionally. So,
**once per token**:

1. one `sessions:feedBlock` IPC message, carrying the **whole accumulated
   block**, not the piece;
2. every mounted `FeedView`'s `onBlock` handler runs (the session filter is in
   the renderer, after the fan-out);
3. the matching one calls `setBlocks(upsertBlock(…))` — a new array identity,
   so the feed re-renders.

## Measured

One assistant turn, before:

| turn | deltas | IPC messages | bytes on the wire | × the turn's own size |
|---|---|---|---|---|
| 1,000 chars | 250 | 251 | 0.15 MB | 152× |
| 4,000 chars | 1,000 | 1,001 | 2.11 MB | 527× |
| 16,000 chars | 4,000 | 4,001 | 32.43 MB | 2,027× |

Bytes are **quadratic** in the turn's length, because each message re-sends
everything before it.

**`upsertBlock` is NOT the problem, and was the first suspect.** Two
`findIndex` scans and a 1,000-element copy looked expensive; it is 4µs a call —
about 1ms of work per second at 240 messages/sec. Do not spend time there.

## The two fixes, against the same turn (60 tokens/sec)

| | messages (16k turn) | bytes |
|---|---|---|
| before | 4,001 | 32.43 MB |
| coalesce re-emits at 50ms | 1,335 (3×) | 10.83 MB (3×) |
| coalesce at 100ms | 668 (6×) | 5.43 MB (6×) |
| send the delta, not the block | 4,000 (1×) | 0.50 MB (65×) |
| both, at 50ms | 1,334 (3×) | 0.18 MB (184×) |

They act on different axes. **Message count is render count** and only
coalescing lowers it. **Bytes are serialisation cost** and only delta-only
removes the quadratic.

## What shipped

Coalescing at 50ms (`FeedBuffer.updateSoon`, `STREAM_COALESCE_MS`), on the token
path only. The "before" row above is the simulation; the 50ms row was then
**re-measured on the shipped code** with the clock running between tokens:
1,335 messages, 10.83 MB. It needs no protocol change — the renderer still
receives whole blocks and upserts on seq exactly as before.

Three things it had to get right, each with a test that goes red without it:

- a block that **stops** is emitted at once and carries every token it was owed;
- a held re-emit **never overwrites the `assistant` message** that superseded
  its block (`replace` puts a new object under the same seq);
- a held re-emit **does not survive a reset**, or one bubble of the old
  conversation comes back after `/clear`.

## What did not ship, and why

**Delta-only** is the bigger win on bytes and is a protocol change: the renderer
would append instead of upsert, across the delta→message supersede that
`stream-feed.ts`'s header spends sixty lines on. Filed as **#1062**.

## #1062 measured in TIME, 2026-10-06: the bytes are not where the time goes

Delta-only saves bytes — 10.83 MB to 0.18 MB on a 16,000-character reply. What
was never measured is what those bytes cost anybody. Asked of the real app with
`spike/probes/716/` (980 real blocks on screen, a key typed every 100 ms, 12 s,
renderer at 4x throttle), using a stream the window cannot render:

`PROBE_GHOSTS=8 PROBE_STEP=67 PROBE_VISIBLE=0` — eight replies, each growing to
16,000 characters at 20 messages a second, each message carrying the whole text
so far, addressed to sessions the window is not showing. Every card hears every
`sessions:feedBlock` and drops the ones that are not its own, so a ghost costs
the renderer exactly what the WIRE costs — receive, decode, one comparison — and
nothing of what a render costs. That is the whole of what delta-only could save.

| 12 s window | renderer main thread busy | of which script | long tasks | main process CPU |
|---|---|---|---|---|
| nothing streaming | 5,090–6,040 ms | 496–566 ms | 0 | 203–375 ms |
| 8 ghost replies, ~15 MB on the wire | 5,293–6,403 ms | 503–632 ms | 0–2 | 391–499 ms |
| ONE visible 16,000-character reply | 10,650–11,640 ms | 2,750–3,330 ms | 0–8 | 297–531 ms |

Eight full-size streams, eight times the bytes #1062 would remove, cost the
renderer nothing that can be told from an idle window and the main process
about 150 ms of CPU in twelve seconds. One reply the window actually DRAWS costs
forty times that.

**So #1062 as written would not move typing lag or the many-sessions lag, and
it was not built.** It is a protocol change across the delta-to-message
supersede for a saving that is real in megabytes and invisible in milliseconds.

What the third row does show is that a reply's cost grows with its own length:
script 2,050 → ~2,900 ms and layout 1,350 → ~2,650 ms between a 2,900- and a
16,000-character reply, at 4x. At 6x that is the one case left that stalls
(8–13 long tasks, 460–750 ms, ~300 frames of 750). The cause is in the
renderer — the whole reply is parsed, sanitised and laid out again on every
chunk — and sending less text would not change it, because the renderer would
append and then do exactly the same work. That is step 1 in
`716-streaming-render-cost.md`, and it is the measured next thing.

## What this probe cannot say

It counts messages and bytes in node. It does **not** measure what one feed
render costs in the renderer, so "3× fewer renders" is a count, not a
percentage of a core. Whether 3× is enough at 8 sessions is a question for the
CPU heartbeat on a real machine — `lagMaxMs` with several sessions streaming,
before and after.
