// A bounded ring of PARSED stream messages — the stream transport's answer to
// the PTY's scrollback RingBuffer (P2-E18-03).
//
// Bounded by COUNT, not bytes, unlike the PTY ring. A PTY's scrollback is a
// byte stream whose useful unit is the screenful; a stream session's is a list
// of discrete messages, and "the last N messages" is what a late-attaching
// renderer actually needs to rebuild a view. Byte-bounding it would evict a
// long assistant turn and keep a hundred keep_alives.

export class MessageRing<T> {
  private readonly items: T[] = [];
  private dropped = 0;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('MessageRing capacity must be > 0');
  }

  push(m: T): void {
    this.items.push(m);
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped++;
    }
  }

  /** Everything still held, oldest first. */
  snapshot(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  /** How many messages have aged out — a late attacher needs to know it missed some. */
  get droppedCount(): number {
    return this.dropped;
  }
}
