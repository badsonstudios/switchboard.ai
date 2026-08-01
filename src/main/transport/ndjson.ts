// NDJSON framing for the stream-json transport (P2-E18-03).
//
// The wire contract, taken from the S-10 probes (`spike/s10/*.cjs`) which read
// the real CLI, not from a guess: stdout is newline-delimited JSON, one message
// per line, blank lines skipped. Written to stdin the same way —
// `JSON.stringify(msg) + '\n'`.
//
// Split out from StreamService because framing is the part with the interesting
// failure modes and it deserves to be testable without spawning anything.

/** A decoded line, or the reason it could not be decoded. */
export type FrameResult<T> = { ok: true; value: T } | { ok: false; raw: string; error: string };

export interface NdjsonDecoderOptions {
  /**
   * Hard cap on a single un-terminated line, in bytes of accumulated string.
   *
   * A CLI that writes a megabyte of JSON on one line is normal (S-10 saw a
   * 35k-token turn); a CLI that never writes a newline again is a bug, and
   * without a cap the buffer grows until the process dies of memory rather than
   * of the actual fault. 32 MB is far above any observed message and far below
   * anything that threatens the app.
   */
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE = 32 * 1024 * 1024;

/**
 * Incremental NDJSON decoder.
 *
 * Deliberately synchronous and allocation-cheap: it is called on every `data`
 * event of a pipe we must never stop draining (S-11 measured the CLI blocking
 * on a full stdout pipe and recovering, so the cost of falling behind is real
 * backpressure on the CLI, not just our own latency).
 */
export class NdjsonDecoder<T = unknown> {
  private buf = '';
  private readonly maxLine: number;
  /** Lines that arrived but were not valid JSON. Framing-integrity signal. */
  parseFailures = 0;
  /** Times a single line blew the cap and had to be abandoned. */
  overlongLines = 0;

  constructor(opts: NdjsonDecoderOptions = {}) {
    this.maxLine = opts.maxLineBytes ?? DEFAULT_MAX_LINE;
  }

  /** Feed a chunk; get back every COMPLETE message it finished. */
  push(chunk: string): FrameResult<T>[] {
    const out: FrameResult<T>[] = [];
    this.buf += chunk;

    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue; // blank lines are not messages — the probes skip them too
      try {
        out.push({ ok: true, value: JSON.parse(line) as T });
      } catch (e) {
        // A torn or garbled line must NOT take the pump down: one bad message
        // costs one message, and the session keeps running (P6 fail-open).
        this.parseFailures++;
        out.push({ ok: false, raw: line, error: String(e) });
      }
    }

    // Whatever is left is a PARTIAL line and is held for the next chunk. This
    // is the whole reason a decoder exists rather than a split('\n') per chunk.
    if (this.buf.length > this.maxLine) {
      this.overlongLines++;
      this.buf = '';
      out.push({ ok: false, raw: '', error: `line exceeded ${this.maxLine} bytes; buffer dropped` });
    }
    return out;
  }

  /** Bytes currently held as an incomplete line — diagnostics only. */
  get pendingBytes(): number {
    return this.buf.length;
  }
}

/** Encode one message for the CLI's stdin. */
export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}
