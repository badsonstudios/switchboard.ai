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

export class RingBuffer {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly maxBytes: number) {
    if (maxBytes <= 0) throw new Error('maxBytes must be > 0');
  }

  push(data: Buffer): void {
    this.chunks.push(data);
    this.total += data.length;
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.total -= dropped.length;
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
    }
  }

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
   */
  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.total);
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}
