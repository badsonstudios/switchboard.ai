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

## What this probe cannot say

It counts messages and bytes in node. It does **not** measure what one feed
render costs in the renderer, so "3× fewer renders" is a count, not a
percentage of a core. Whether 3× is enough at 8 sessions is a question for the
CPU heartbeat on a real machine — `lagMaxMs` with several sessions streaming,
before and after.
