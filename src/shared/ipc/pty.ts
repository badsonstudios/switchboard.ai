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

/**
 * What `pty:snapshot` resolves with — the ring buffer, READ (#517).
 *
 * `pty:attach` already hands out the same bytes, but it cannot be used for
 * this: attaching MINTS AN EPOCH and REPLACES the session's one data feed
 * (`feeds.get(id)?.()`), so a second consumer asking for a copy would silently
 * cut the pane that is actually on screen. This channel subscribes to nothing,
 * mints nothing, and mutates nothing — it is `snapshot()` and the geometry,
 * which is exactly what find needs and nothing else.
 *
 * `null` means there is no PTY under that id — the honest "we could not look",
 * as distinct from "we looked and found none".
 *
 * WHY THE GEOMETRY COMES WITH IT: the bytes are a stream the CLI wrote for a
 * terminal of a PARTICULAR WIDTH, and a scrollback is only meaningful when it
 * is replayed at that width. Re-render 120-column output at the xterm default
 * of 80 and every long line wraps somewhere else, which moves match positions
 * and can split a match across the fold. So the reader is told the shape to
 * replay into rather than left to guess it.
 */
export interface PtySnapshot {
  /** Scrollback as of this call, utf8. Same bytes `pty:attach` would replay. */
  snapshot: string;
  /** the PTY's current width/height, so a replay wraps where the CLI wrapped */
  cols: number;
  rows: number;
}
