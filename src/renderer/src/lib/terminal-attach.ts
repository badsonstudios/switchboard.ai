// Attaching a terminal to a live PTY without losing — or duplicating — the
// bytes in between (#117).
//
// Main's `pty:attach` handler subscribes to the PTY and takes the scrollback
// snapshot in ONE synchronous tick, so the split is exact: everything up to
// that instant is in the snapshot, everything after it arrives on
// `pty:data:<id>`. The renderer used to register that listener only after the
// invoke promise resolved — a full IPC round trip later — so every chunk main
// emitted in the gap was sent to a channel with no listener and silently
// dropped. The ring buffer still held those bytes, but nothing replayed them:
// the snapshot had already been taken before they existed.
//
// So we subscribe FIRST, which removes the window rather than narrowing it. That
// inverts the ordering problem, and creates a second one:
//
//  1. ORDER. A chunk that arrives during the round trip is NEWER than the
//     snapshot we are about to write. xterm's write queue is FIFO and `reset()`
//     does not drain it, so writing that chunk on arrival would have it parsed
//     BEFORE the snapshot's content — out of order, which for a TUI redraw is
//     indistinguishable from corruption. Hence the buffer: gap chunks are held,
//     then flushed after the snapshot, in arrival order.
//  2. EPOCH. Subscribing before invoking also means a chunk main sent for a
//     PREVIOUS attach can still be in the renderer's message queue when this
//     one subscribes — and that chunk predates our snapshot, because it reached
//     the ring buffer before the snapshot was taken. Arrival time cannot
//     separate the two cases; the epoch can (see shared/ipc/pty.ts).
//     Without it, a rapid re-attach trades #117's silent loss for duplicated
//     output — and React StrictMode makes the double-attach happen on every
//     mount in development.
//
// The buffer is uncapped on purpose. It lives for exactly one IPC round trip,
// and the invoke always settles — a refused or unregistered channel rejects at
// the broker rather than hanging — so it always drains. The only thing a cap
// could do is drop bytes, which is the bug.
//
// Known and pre-existing, not introduced here: because `reset()` does not drain
// xterm's write queue, output still pending from a previous attach can be
// parsed after the reset and before the new snapshot.
import type { PtyAttachment, PtyChunk } from '../../../shared/ipc/pty';
import { answered } from '../../../shared/ipc/refusal';

/** Everything this module needs from the outside world. Structurally typed so
 *  the tests can hand it plain functions — no xterm, no preload bridge. */
export interface TerminalFeedPorts {
  /** Register the `pty:data:<id>` listener. Returns an unsubscribe. */
  subscribe: (onChunk: (chunk: PtyChunk) => void) => () => void;
  /** Invoke `pty:attach`. Resolves with the snapshot and its epoch, or null
   *  when there is no live PTY for this id. */
  attach: () => Promise<PtyAttachment | null>;
  /** Tell main to stop streaming. Called from `off()`, so the pair is owned in
   *  one place — see the ordering note on `off()`. */
  detach?: () => void;
  /** Clear the view before the snapshot is replayed. */
  reset: () => void;
  /** Write to the view. Called with the snapshot, then any buffered chunks,
   *  then every later chunk as it arrives. */
  write: (d: string) => void;
  /** The snapshot and any gap chunks are on screen. Fired at most once, and
   *  outside the data path: a throw from here cannot stop the stream. */
  onReady?: () => void;
  /** Something went wrong. We fail open: the terminal may be missing output,
   *  but the card, the window and the session keep running. */
  onError?: (err: unknown) => void;
}

export interface TerminalFeed {
  /** Resolves once the feed is live — or once it has failed open. Never
   *  rejects; failures go to `onError`. */
  ready: Promise<void>;
  /** Stop the feed and discard anything still buffered. Idempotent, and safe
   *  to call while the attach round trip is still in flight.
   *
   *  Ordering note: `detach` is a `send` and `attach` an `invoke` on the same
   *  renderer→main pipe, which Electron dispatches FIFO. That is what makes
   *  "off() before main has even handled our attach" safe — main registers the
   *  feed, then tears it down. */
  off: () => void;
}

/**
 * Subscribe, then attach, then replay: snapshot first, buffered chunks from
 * this epoch after it, live chunks straight through from then on.
 */
export function attachTerminalFeed(ports: TerminalFeedPorts): TerminalFeed {
  let epoch: number | null = null; // this attach's epoch; null until it resolves
  let live = false;
  let closed = false;
  let pending: PtyChunk[] = [];
  let writeErrorReported = false;

  const fail = (err: unknown): void => {
    // Nothing to report if the caller already tore this feed down: a rejection
    // that lands after unmount ("channel closed" at quit) is expected, not a
    // problem the pane can do anything about.
    const wasClosed = closed;
    off();
    if (!wasClosed) safely(() => ports.onError?.(err));
  };

  const onChunk = (chunk: PtyChunk): void => {
    // A listener removed DURING dispatch of an event it is registered for still
    // runs (EventEmitter snapshots the array), so this guard is load bearing,
    // not decoration.
    if (closed) return;
    if (!live) {
      pending.push(chunk); // epoch is judged at flush time, not now
      return;
    }
    // Drop only STRICTLY older epochs — those are the stragglers our snapshot
    // already contains. A NEWER epoch means something attached after us and
    // main's single feed per session now streams under that epoch; the bytes in
    // between were streamed under ours, so adopting it loses nothing and keeps
    // this pane alive. Cannot happen while there is one pane per session (main
    // keeps one feed, the renderer builds one TerminalPane), which is exactly
    // why the strict version would fail silently the day that stops being true.
    if (epoch === null || chunk.epoch < epoch) return;
    epoch = chunk.epoch;
    try {
      ports.write(chunk.d);
    } catch (err) {
      // A write failure must not tear the feed down — the next TUI redraw is the
      // recovery.
      reportWriteFailure(err);
    }
  };

  /** Write failures repeat per chunk (xterm's buffer stays over its limit), so
   *  they are reported once and then swallowed. */
  const reportWriteFailure = (err: unknown): void => {
    if (writeErrorReported) return;
    writeErrorReported = true;
    safely(() => ports.onError?.(err));
  };

  // A throw from subscribe is reported and survived rather than fatal: the
  // snapshot below still lands, so the pane shows history without a live feed.
  // Deliberately NOT fail() — that closes the feed, which would abort the very
  // replay this comment promises.
  let unsubscribe: () => void = () => {};
  try {
    unsubscribe = ports.subscribe(onChunk);
  } catch (err) {
    safely(() => ports.onError?.(err));
  }

  function off(): void {
    if (closed) return;
    closed = true;
    live = false;
    pending = [];
    safely(unsubscribe);
    safely(() => ports.detach?.());
  }

  let ready = Promise.resolve();
  try {
    ready = ports.attach().then((answer) => {
      // `answered` centrally (#650), same reason as `terminal-shadow.ts`:
      // `attach` is an injected closure and this is the only place that can
      // see its value.
      //
      // BEHAVIOUR-IDENTICAL TODAY, and said plainly rather than dressed up: a
      // refusal has no `epoch` and no `snapshot`, so `?.` already lands it on
      // exactly the "no live PTY" path a `null` attachment takes. What the
      // launderer buys is that it lands there BY CONSTRUCTION instead of by
      // the brand happening to lack two fields — and the cost of being wrong
      // about that is the one named two comments down: an `epoch` that stays
      // null while the feed goes live drops every later chunk, silently and
      // for good, which is #117's failure mode through the path written to
      // survive it.
      const attachment = answered(answer);
      if (closed) return;
      // FIRST, before anything that can throw. If a reset() failure left this
      // null while the catch below marked the feed live, every later chunk would
      // fail the epoch test and be dropped — silently and for good, which is
      // #117's own failure mode reached through the path meant to survive it.
      epoch = attachment?.epoch ?? null;
      const batch = pending;
      pending = [];
      try {
        ports.reset();
        if (attachment?.snapshot) ports.write(attachment.snapshot);
        // Everything buffered from this epoch onwards is newer than the
        // snapshot; anything older is already in it. A null attachment means no
        // live PTY, so nothing can be ours.
        for (const chunk of batch) {
          if (epoch === null || chunk.epoch < epoch) continue;
          epoch = chunk.epoch;
          // per chunk: one bad write must not swallow the rest of the replay
          try {
            ports.write(chunk.d);
          } catch (err) {
            reportWriteFailure(err);
          }
        }
        live = true;
      } catch (err) {
        // The snapshot replay failed. Stay attached AND live rather than leaving
        // a dead pane behind: the effect will not re-run until the pane is
        // toggled, so tearing down here means no output until the user notices.
        live = true;
        safely(() => ports.onError?.(err));
        return;
      }
      // Outside the try on purpose: onReady is the fit/resize hook, which
      // reaches into xterm geometry and can throw. Cosmetics must not be able
      // to poison the data path — but they must not vanish silently either.
      try {
        ports.onReady?.();
      } catch (err) {
        safely(() => ports.onError?.(err));
      }
    }, fail);
  } catch (err) {
    // A synchronous throw from `attach()` — a broken bridge, a clone failure —
    // would otherwise escape the caller's effect AND leave the listener
    // registered with no handle to remove it, since the caller never gets a
    // TerminalFeed back.
    fail(err);
  }

  return { ready, off };
}

/** Run `f`, swallowing anything it throws. For notification and teardown calls
 *  where a throw would take out the caller's cleanup path. */
function safely(f: () => void): void {
  try {
    f();
  } catch {
    // nothing useful to do here: the reporter itself is what failed
  }
}

