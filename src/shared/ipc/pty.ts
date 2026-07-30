// The `pty:attach` / `pty:data:<id>` wire shapes (#117).
//
// Both carry an EPOCH: one attach of one pane to one PTY. Main mints it when it
// subscribes, stamps every chunk it streams with it, and hands it back with the
// snapshot taken in that same tick.
//
// Why the renderer cannot do without it: attaching is subscribe-then-invoke, so
// a chunk main sent for a PREVIOUS attach can still be sitting in the renderer's
// message queue when the next pane subscribes. That chunk reached the ring buffer
// before the new snapshot was taken — so it is in the snapshot, or it has already
// aged out of it (the ring evicts at 2 MB); either way replaying it now would put
// it after content that came later. Arrival time cannot tell the two cases apart
// (both land after the invoke was issued); the epoch can, and exactly:
//
//   chunk.epoch >= attachment.epoch → not in the snapshot, must be replayed
//   chunk.epoch <  attachment.epoch → predates the snapshot, must be dropped
//
// Strictly-older rather than not-equal on purpose: a HIGHER epoch means another
// attach superseded ours (main keeps one feed per session), and those bytes are
// genuinely new. Unreachable while there is one pane per session — which is why
// the tighter test would fail silently the day that changes.

/** What `pty:attach` resolves with. `null` means there is no live PTY for that id. */
export interface PtyAttachment {
  epoch: number;
  /** Scrollback as of the instant the stream started, utf8. */
  snapshot: string;
}

/** One chunk on `pty:data:<sessionId>`. */
export interface PtyChunk {
  epoch: number;
  d: string;
}
