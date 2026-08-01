// P2-E18-03 — NDJSON framing.
//
// The wire contract comes from the S-10 probes reading the real CLI
// (`spike/s10/*.cjs`), not from a guess: newline-delimited JSON, one message
// per line, blank lines skipped, `JSON.stringify(msg) + '\n'` inbound.
import { describe, it, expect } from 'vitest';
import { NdjsonDecoder, encodeFrame } from './ndjson';

function values<T>(rs: ReturnType<NdjsonDecoder<T>['push']>): T[] {
  return rs.filter((r): r is { ok: true; value: T } => r.ok).map((r) => r.value);
}

describe('NdjsonDecoder (P2-E18-03)', () => {
  it('decodes one message per line', () => {
    const d = new NdjsonDecoder();
    expect(values(d.push('{"type":"system"}\n'))).toEqual([{ type: 'system' }]);
  });

  it('decodes SEVERAL messages arriving in one chunk', () => {
    const d = new NdjsonDecoder();
    const out = values(d.push('{"n":1}\n{"n":2}\n{"n":3}\n'));
    expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('reassembles ONE message split across chunks', () => {
    const d = new NdjsonDecoder();
    expect(values(d.push('{"ty'))).toEqual([]);
    expect(values(d.push('pe":"ass'))).toEqual([]);
    expect(values(d.push('istant"}\n'))).toEqual([{ type: 'assistant' }]);
  });

  it('holds a PARTIAL trailing line instead of dropping it', () => {
    const d = new NdjsonDecoder();
    const first = values(d.push('{"n":1}\n{"n":2'));
    expect(first).toEqual([{ n: 1 }]); // the complete one only
    expect(d.pendingBytes).toBeGreaterThan(0);

    expect(values(d.push('}\n'))).toEqual([{ n: 2 }]); // and the rest arrives intact
    expect(d.pendingBytes).toBe(0);
  });

  it('survives a chunk boundary landing exactly on the newline', () => {
    const d = new NdjsonDecoder();
    expect(values(d.push('{"n":1}'))).toEqual([]);
    expect(values(d.push('\n'))).toEqual([{ n: 1 }]);
  });

  it('skips blank lines rather than reporting them as failures', () => {
    const d = new NdjsonDecoder();
    const out = d.push('\n\n{"n":1}\n\n');
    expect(values(out)).toEqual([{ n: 1 }]);
    expect(d.parseFailures).toBe(0);
  });

  // S-10 saw a 35k-token turn; a single message being large is normal, not an
  // attack. Framing must not have a "reasonable size" opinion.
  it('carries a ~500 KB single message intact', () => {
    const d = new NdjsonDecoder<{ text: string }>();
    const big = 'x'.repeat(500 * 1024);
    const out = values(d.push(JSON.stringify({ text: big }) + '\n'));
    expect(out[0].text).toHaveLength(500 * 1024);
  });

  it('carries a large message split across many small chunks', () => {
    const d = new NdjsonDecoder<{ text: string }>();
    const line = JSON.stringify({ text: 'y'.repeat(200 * 1024) }) + '\n';
    const CHUNK = 4096;
    let out: { text: string }[] = [];
    for (let i = 0; i < line.length; i += CHUNK) {
      out = out.concat(values(d.push(line.slice(i, i + CHUNK))));
    }
    expect(out).toHaveLength(1);
    expect(out[0].text).toHaveLength(200 * 1024);
  });

  // Fail-open (P6): one torn line costs one message, not the session.
  it('counts a malformed line and KEEPS DECODING the ones after it', () => {
    const d = new NdjsonDecoder();
    const out = d.push('{"n":1}\nNOT JSON AT ALL\n{"n":2}\n');

    expect(values(out)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(d.parseFailures).toBe(1);
    const bad = out.find((r) => !r.ok);
    expect(bad && !bad.ok && bad.raw).toBe('NOT JSON AT ALL');
  });

  it('a run of garbage does not wedge the decoder', () => {
    const d = new NdjsonDecoder();
    d.push('garbage\n'.repeat(50));
    expect(d.parseFailures).toBe(50);
    expect(values(d.push('{"ok":true}\n'))).toEqual([{ ok: true }]);
  });

  // Without a cap, a CLI that stops emitting newlines grows the buffer until
  // the process dies of memory rather than of the actual fault.
  it('abandons an un-terminated line past the cap, and recovers after it', () => {
    const d = new NdjsonDecoder({ maxLineBytes: 1024 });
    const out = d.push('z'.repeat(2048));

    expect(d.overlongLines).toBe(1);
    expect(out.some((r) => !r.ok && r.raw === '')).toBe(true);
    expect(d.pendingBytes).toBe(0);

    expect(values(d.push('{"back":1}\n'))).toEqual([{ back: 1 }]);
  });

  it('a legitimate large line UNDER the cap is not abandoned', () => {
    const d = new NdjsonDecoder({ maxLineBytes: 1024 * 1024 });
    const line = JSON.stringify({ text: 'q'.repeat(300 * 1024) }) + '\n';
    expect(values(d.push(line))).toHaveLength(1);
    expect(d.overlongLines).toBe(0);
  });
});

describe('encodeFrame (P2-E18-03)', () => {
  it('is exactly JSON + newline — the shape the probes wrote to the real CLI', () => {
    expect(encodeFrame({ type: 'user' })).toBe('{"type":"user"}\n');
  });

  it('round-trips through the decoder', () => {
    const d = new NdjsonDecoder();
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi\nthere' }] } };
    expect(values(d.push(encodeFrame(msg)))).toEqual([msg]);
  });

  // A newline inside a string is escaped by JSON.stringify, so it can never be
  // mistaken for a frame boundary. Worth pinning: it is the assumption the
  // whole framing rests on.
  it('escapes embedded newlines so they cannot forge a frame boundary', () => {
    expect(encodeFrame({ t: 'a\nb' })).toBe('{"t":"a\\nb"}\n');
    const d = new NdjsonDecoder();
    expect(values(d.push(encodeFrame({ t: 'a\nb' })))).toEqual([{ t: 'a\nb' }]);
  });
});
