// Byte ring buffer for PTY scrollback (S-07 verdict: hidden panes don't
// render — they ingest into a capped buffer; xterm attaches on focus and
// replays this). Cap ~ scrollback 5000 lines of typical TUI output.

/**
 * First index at or after `i` that starts a UTF-8 character — i.e. skip
 * CONTINUATION bytes (`0b10xxxxxx`), which can never begin one (#205).
 *
 * Bounded by 3: a UTF-8 character is at most 4 bytes, so at most 3
 * continuation bytes can follow its lead byte. The bound is what makes this
 * safe on a buffer of ARBITRARY bytes — on input that isn't valid UTF-8 we
 * give up and return an index that may still be a continuation byte, costing
 * one extra replacement char at the head of already-garbage data rather than
 * eating the whole buffer looking for a lead byte that isn't there.
 */
const startOfChar = (buf: Buffer, i: number): number => {
  const limit = Math.min(buf.length, i + 3);
  let start = i;
  while (start < limit && (buf[start] & 0xc0) === 0x80) start++;
  return start;
};

/**
 * Index of the first byte that is safe to RESUME a terminal stream at, given
 * that whatever came before this buffer was discarded mid-stream (#211).
 *
 * UTF-8 alignment (#205) is not SEQUENCE alignment: a cut can land inside
 * `\x1b[38;5;10m` just as easily as inside an emoji, and xterm renders the
 * orphaned tail as literal text — a replay that opens with `38;5;10m`.
 *
 * We do NOT parse (host-don't-reimplement: we are not writing a VT parser to
 * fix a cosmetic cut). We skip to the nearest byte that a sequence begun before
 * the cut is overwhelmingly unlikely to span, whichever comes first:
 *  - `ESC` (0x1b) — normally a new sequence starts here; if instead we were cut
 *    inside a string payload, this is its `ESC \` terminator, which xterm.js
 *    registers as an explicit no-op (`registerEscHandler({final:'\\'}, …)`), so
 *    a stray ST renders nothing. ESC can also be DATA inside a string payload
 *    (tmux's DCS passthrough doubles it), in which case we resume mid-payload —
 *    bounded garbage, never worse than the unfixed cut.
 *  - the byte after `LF` (0x0a) — no realistic emitter puts a raw newline in a
 *    sequence, so a line break means the sequence ended before it. A string
 *    payload legally may (xterm.js ignores C0 inside OSC and stays in the
 *    string); then we resume mid-payload, again bounded and no worse.
 *
 * The earlier of the two wins, so we discard as little as possible: in
 * escape-heavy output that is a handful of bytes, and in plain text at most the
 * first line — usually the half-line eviction had already cut, but a
 * line-aligned eviction boundary can cost one intact line out of the cap.
 *
 * Neither anchor present ⇒ 0: keep everything. That buffer holds no ESC and no
 * newline at all — vanishingly rare (it takes a whole cap's worth of such
 * bytes: a `\r`-only progress meter, or one oversized base64 OSC payload), and
 * leaving it alone is exactly the status quo, never worse.
 *
 * Both anchors are single-byte ASCII, so this can never re-break #205: the
 * returned index always starts a whole character.
 */
const safeResumeStart = (buf: Buffer): number => {
  const esc = buf.indexOf(0x1b);
  const lf = buf.indexOf(0x0a);
  if (esc !== -1 && (lf === -1 || esc < lf)) return esc;
  if (lf !== -1) return lf + 1;
  return 0;
};

export class RingBuffer {
  private chunks: Buffer[] = [];
  private total = 0;
  /** true once ANY byte has been dropped — i.e. the head is a mid-stream cut. */
  private discarded = false;

  constructor(private readonly maxBytes: number) {
    if (maxBytes <= 0) throw new Error('maxBytes must be > 0');
  }

  push(data: Buffer): void {
    this.chunks.push(data);
    this.total += data.length;
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.total -= dropped.length;
      this.discarded = true;
    }
    // single oversized chunk: keep only its tail — starting on a CHARACTER
    // boundary, not a raw byte one (#205). Cutting at `length - maxBytes`
    // lands mid-character 3 times in 4 for an emoji, and the snapshot is
    // decoded as UTF-8 on attach, so the replay would open with `U+FFFD`.
    // Dropping up to 3 bytes below the cap is free: the cap is a maximum.
    //
    // A cap NARROWER than the character at the cut leaves nothing to keep
    // (`maxBytes` 2, a 4-byte emoji) — an empty buffer is the honest answer,
    // half a character is not, and the next push refills it.
    //
    // `Buffer.from` COPIES: a `subarray` view would pin the whole oversized
    // allocation (>2 MB, by definition) for the life of the session.
    if (this.total > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0];
      const kept = Buffer.from(only.subarray(startOfChar(only, only.length - this.maxBytes)));
      this.chunks[0] = kept;
      this.total = kept.length;
      this.discarded = true;
    }
  }

  /**
   * Bytes RETAINED — what counts against the cap.
   *
   * `snapshot()` can hand out slightly fewer: once bytes have been discarded it
   * also drops the head back to a safe resume point (#211). The prefix it skips
   * is still held here because the cap is about memory, not about what a replay
   * can legally start with.
   */
  get byteLength(): number {
    return this.total;
  }

  /**
   * Full buffered contents (for attach-on-focus replay).
   *
   * Decodable as UTF-8 on its own (#205) — the caller needs no `StringDecoder`
   * and there is nothing to flush, because the buffer never holds a PARTIAL
   * character at either end:
   *  - the head: the only cut this class makes is the oversized-chunk trim
   *    above, and it now lands on a character boundary. Ordinary eviction drops
   *    WHOLE chunks, and a whole chunk is whole characters — the PTY hands us a
   *    decoded string and `pty-service` re-encodes it (`Buffer.from(d,'utf8')`),
   *    so a chunk can never begin or end mid-character.
   *  - the tail: never cut at all.
   *
   * And it starts at a SAFE RESUME POINT (#211): once anything has been
   * discarded, the head is a mid-stream cut, so we skip forward to the nearest
   * anchor a sequence won't have spanned (see `safeResumeStart`) — or leave the
   * buffer alone when it holds no ESC and no LF at all. Until the first
   * eviction the head IS the start of the stream: nothing was cut, so nothing
   * is skipped.
   *
   * The result is a VIEW over a buffer allocated for this call — decode it and
   * let it go rather than retaining it.
   *
   * Both passes are `indexOf` (memchr) over an already-concatenated buffer, on
   * the attach path only. The push path pays nothing: alignment needs the
   * WHOLE buffer to find the earliest anchor, and doing it per-eviction would
   * both miss anchors that sit in the next chunk and charge every session for
   * a replay most of them never ask for.
   */
  snapshot(): Buffer {
    const buf = Buffer.concat(this.chunks, this.total);
    if (!this.discarded) return buf;
    const start = safeResumeStart(buf);
    return start === 0 ? buf : buf.subarray(start);
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
    this.discarded = false;
  }
}
