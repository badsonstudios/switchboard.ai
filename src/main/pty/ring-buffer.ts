// Byte ring buffer for PTY scrollback (S-07 verdict: hidden panes don't
// render — they ingest into a capped buffer; xterm attaches on focus and
// replays this). Cap ~ scrollback 5000 lines of typical TUI output.
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
    // single oversized chunk: keep only its tail
    if (this.total > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0];
      this.chunks[0] = only.subarray(only.length - this.maxBytes);
      this.total = this.maxBytes;
    }
  }

  get byteLength(): number {
    return this.total;
  }

  /** Full buffered contents (for attach-on-focus replay). */
  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.total);
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}
