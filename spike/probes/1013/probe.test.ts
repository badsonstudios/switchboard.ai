/**
 * PROBE for #1013 / #716 — where the renderer's core goes while sessions stream.
 *
 * NOT a CI test. `spike/**` is outside `vitest.config.ts`'s `include`, so this
 * file only runs when asked for by name:
 *
 *   npx vitest run spike/probes/1013/probe.test.ts --include 'spike/**\/*.test.ts'
 *
 * It measures three costs that compose on the streaming path, none of which
 * had a number against them. #716 says "profile first, then fix — don't guess",
 * and #1013's capture says WHERE (the renderer, 0.7-1.0 cores, lag to 2.7s) but
 * not WHAT. These are the whats.
 *
 * The three:
 *   1. IPC messages per assistant turn, and the BYTES they carry. Every
 *      `content_block_delta` calls `FeedBuffer.update`, which fires
 *      unconditionally -> one `sessions:feedBlock` per token, each carrying the
 *      WHOLE accumulated block. Quadratic in the turn's length.
 *   2. `upsertBlock`, the renderer's reducer, at a full 1,000-block window --
 *      two front-to-back `findIndex` scans plus a 1,000-element array copy, per
 *      message from (1).
 *   3. Both at the fleet width #1013 reported: 8 sessions streaming at once.
 */
import { describe, it, vi } from 'vitest';
import { StreamFeed } from '../../../src/main/feed/stream-feed';
import { upsertBlock, FeedBlockDto } from '../../../src/renderer/src/lib/feed';

const CONV = '00000000-conv-4000-8000-000000000000';

const ev = (event: Record<string, unknown>): Record<string, unknown> => ({
  type: 'stream_event',
  event,
  session_id: CONV,
  parent_tool_use_id: null,
});
const textDelta = (text: string, index = 0) =>
  ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });

/** A realistic assistant turn: `chars` of prose at ~4 chars per token. */
function turn(chars: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < Math.ceil(chars / 4); i++) pieces.push('word');
  return pieces;
}

/** What `send('sessions:feedBlock', …)` would put on the wire for one block. */
const wireBytes = (b: unknown): number => JSON.stringify(b).length;

describe('#1013 — the streaming hot path', () => {
  it('1. counts IPC messages and bytes for ONE assistant turn', () => {
    for (const chars of [1_000, 4_000, 16_000]) {
      const feed = new StreamFeed();
      let msgs = 0;
      let bytes = 0;
      feed.onBlock((_sid, b) => {
        msgs++;
        bytes += wireBytes(b);
      });
      const pieces = turn(chars);
      const t0 = performance.now();
      for (const p of pieces) feed.offer('live-1', textDelta(p));
      const ms = performance.now() - t0;
      console.log(
        `  turn of ${String(chars).padStart(6)} chars (${String(pieces.length).padStart(4)} deltas): ` +
          `${String(msgs).padStart(4)} IPC msgs · ` +
          `${(bytes / 1_000_000).toFixed(2)} MB on the wire · ` +
          `${ms.toFixed(1)}ms in main · ` +
          `amplification ${(bytes / chars).toFixed(0)}x the turn's own size`
      );
    }
  });

  it('1b. the SAME turn in real stream time (60 tok/s) — what the shipped code sends', () => {
    // Test 1 offers every delta in one synchronous burst, which is the cost
    // BEFORE `updateSoon` existed and, after it, collapses to a single message.
    // This one lets the clock run between tokens, so it measures the fix.
    vi.useFakeTimers();
    try {
      for (const chars of [4_000, 16_000]) {
        const feed = new StreamFeed();
        let msgs = 0;
        let bytes = 0;
        feed.onBlock((_sid, b) => {
          msgs++;
          bytes += wireBytes(b);
        });
        const pieces = turn(chars);
        for (const p of pieces) {
          feed.offer('live-1', textDelta(p));
          vi.advanceTimersByTime(1000 / 60);
        }
        vi.advanceTimersByTime(1000);
        console.log(
          `  turn of ${String(chars).padStart(6)} chars (${String(pieces.length).padStart(4)} deltas @60 tok/s): ` +
            `${String(msgs).padStart(4)} IPC msgs · ${(bytes / 1_000_000).toFixed(2)} MB on the wire`
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('2. times upsertBlock at a full 1,000-block window', () => {
    const blocks: FeedBlockDto[] = [];
    for (let i = 1; i <= 1000; i++) {
      blocks.push({ seq: i, kind: 'assistant', text: 'x'.repeat(200) } as FeedBlockDto);
    }
    // The hot case: the block being updated is the LAST one (the turn being
    // streamed), and `findIndex` scans from the front to reach it.
    const hot = { ...blocks[999], text: 'y'.repeat(200) } as FeedBlockDto;
    const N = 2000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) upsertBlock(blocks, hot);
    const ms = performance.now() - t0;
    console.log(
      `  upsertBlock on a 1,000-block feed: ${((ms / N) * 1000).toFixed(1)}µs per call ` +
        `(${(N / (ms / 1000)).toFixed(0)}/sec ceiling on one core, doing nothing else)`
    );
  });

  it('2b. the two candidate fixes, measured against the same turn', () => {
    // Fix A — COALESCE: hold the block and emit at most once per `window` ms.
    // Fix B — SEND THE DELTA: emit the piece, not the accumulated block, and
    //         let the renderer append. Kills the quadratic outright.
    for (const chars of [4_000, 16_000]) {
      const pieces = turn(chars);
      // today
      let todayMsgs = 0;
      let todayBytes = 0;
      {
        const feed = new StreamFeed();
        feed.onBlock((_s, b) => {
          todayMsgs++;
          todayBytes += wireBytes(b);
        });
        for (const p of pieces) feed.offer('live-1', textDelta(p));
      }
      // Fix A, simulated at the emit boundary: one emit per `window` ms of
      // stream time at a realistic 60 tok/s, carrying the block as it stands.
      for (const [rate, win] of [
        [60, 50],
        [60, 100],
      ] as const) {
        const perWindow = Math.max(1, Math.round((rate * win) / 1000));
        let msgs = 0;
        let bytes = 0;
        let acc = 0;
        for (let i = 0; i < pieces.length; i++) {
          acc += pieces[i].length;
          if (i % perWindow === 0 || i === pieces.length - 1) {
            msgs++;
            bytes += acc + 120; // the block's text plus its envelope fields
          }
        }
        console.log(
          `  ${String(chars).padStart(5)}ch · COALESCE @${win}ms (${rate} tok/s): ` +
            `${String(msgs).padStart(4)} msgs (${(todayMsgs / msgs).toFixed(0)}x fewer) · ` +
            `${(bytes / 1_000_000).toFixed(2)} MB (${(todayBytes / bytes).toFixed(0)}x less)`
        );
      }
      // Fix B: one message per delta, but carrying only the delta.
      const bBytes = pieces.reduce((n, p) => n + p.length + 120, 0);
      console.log(
        `  ${String(chars).padStart(5)}ch · DELTA-ONLY           : ` +
          `${String(pieces.length).padStart(4)} msgs (1x) · ` +
          `${(bBytes / 1_000_000).toFixed(2)} MB (${(todayBytes / bBytes).toFixed(0)}x less)`
      );
      // A+B together: coalesced AND delta-only.
      for (const win of [50] as const) {
        const perWindow = Math.max(1, Math.round((60 * win) / 1000));
        const msgs = Math.ceil(pieces.length / perWindow);
        const bytes = chars + msgs * 120;
        console.log(
          `  ${String(chars).padStart(5)}ch · BOTH @${win}ms          : ` +
            `${String(msgs).padStart(4)} msgs (${(todayMsgs / msgs).toFixed(0)}x fewer) · ` +
            `${(bytes / 1_000_000).toFixed(3)} MB (${(todayBytes / bytes).toFixed(0)}x less)`
        );
      }
    }
  });

  it('3. the fleet cost #1013 actually reported: 8 sessions streaming', () => {
    // 8 sessions, each mid-turn, each emitting at the token rate. The renderer
    // runs EVERY FeedView's `onBlock` handler for EVERY session's block
    // (FeedView.tsx:449 filters by sessionId in the renderer, after the fan-out),
    // so handler invocations are messages x cards.
    const SESSIONS = 8;
    const TOKENS_PER_SEC = 30; // one session's rough streaming rate
    const msgsPerSec = SESSIONS * TOKENS_PER_SEC;
    const handlerCallsPerSec = msgsPerSec * SESSIONS;

    const blocks: FeedBlockDto[] = [];
    for (let i = 1; i <= 1000; i++) {
      blocks.push({ seq: i, kind: 'assistant', text: 'x'.repeat(200) } as FeedBlockDto);
    }
    const hot = { ...blocks[999] } as FeedBlockDto;
    const N = 500;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) upsertBlock(blocks, hot);
    const perCallMs = (performance.now() - t0) / N;

    console.log(
      `  ${SESSIONS} sessions x ${TOKENS_PER_SEC} tok/s = ${msgsPerSec} IPC msgs/sec, ` +
        `${handlerCallsPerSec} onBlock handler calls/sec`
    );
    console.log(
      `  reducer alone: ${(msgsPerSec * perCallMs).toFixed(0)}ms of work per second of wall clock ` +
        `= ${((msgsPerSec * perCallMs) / 10).toFixed(0)}% of one core, BEFORE React renders anything`
    );
    console.log(
      `  (and each of those ${msgsPerSec} msgs/sec also re-renders the feed: regroup + markdown over up to 1,000 blocks)`
    );
  });
});
