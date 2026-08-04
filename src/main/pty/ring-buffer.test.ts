import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ring-buffer';
import { buildEnv } from './pty-service';

describe('RingBuffer', () => {
  it('keeps everything under the cap', () => {
    const rb = new RingBuffer(100);
    rb.push(Buffer.from('a'.repeat(40)));
    rb.push(Buffer.from('b'.repeat(40)));
    expect(rb.byteLength).toBe(80);
    expect(rb.snapshot().toString()).toBe('a'.repeat(40) + 'b'.repeat(40));
  });

  it('drops oldest chunks past the cap', () => {
    const rb = new RingBuffer(100);
    rb.push(Buffer.from('a'.repeat(60)));
    rb.push(Buffer.from('b'.repeat(60)));
    expect(rb.byteLength).toBe(60);
    expect(rb.snapshot().toString()).toBe('b'.repeat(60));
  });

  it('keeps the tail of a single oversized chunk', () => {
    const rb = new RingBuffer(10);
    rb.push(Buffer.from('0123456789abcdef'));
    expect(rb.snapshot().toString()).toBe('6789abcdef');
  });

  // #205: the oversized-chunk trim used to cut at a raw byte offset, so a
  // scrollback replay could open mid-character and render `U+FFFD`.
  describe('trims to a character boundary (#205)', () => {
    // U+FFFD, built rather than typed so no source encoding can hide it
    const REPLACEMENT = String.fromCharCode(0xfffd);
    // one of every UTF-8 width, so the cut can land on each interior byte:
    // a(1) é(2) 日(3) 😀(4) b(1) = 11 bytes, 5 characters
    const text = 'aé日😀b';
    const buf = Buffer.from(text, 'utf8');

    // Every cut offset that actually cuts (`cut` 0 would mean maxBytes ===
    // length, which never trims), including the 6 that fall INSIDE a character
    // (é's 2nd byte, 日's 2nd and 3rd, 😀's 2nd, 3rd and 4th). `maxBytes` is
    // chosen so the trim starts at exactly `cut`.
    for (let cut = 1; cut < buf.length; cut++) {
      it(`cut at byte ${cut} decodes cleanly`, () => {
        const maxBytes = buf.length - cut;
        const rb = new RingBuffer(maxBytes);
        rb.push(buf);
        const kept = rb.snapshot().toString('utf8');

        // the point of the fix
        expect(kept).not.toContain(REPLACEMENT);
        // nothing was corrupted or reordered: what we kept is a real suffix
        expect(text.endsWith(kept)).toBe(true);
        // the cap is still a cap...
        expect(Buffer.byteLength(kept, 'utf8')).toBeLessThanOrEqual(maxBytes);
        // ...and we gave up at most the 3 bytes a partial character can cost
        expect(maxBytes - Buffer.byteLength(kept, 'utf8')).toBeLessThanOrEqual(3);
        // byteLength must agree with what snapshot() hands out
        expect(rb.byteLength).toBe(Buffer.byteLength(kept, 'utf8'));
      });
    }

    it('keeps NOTHING rather than half a character when the cap is narrower', () => {
      const rb = new RingBuffer(2); // narrower than the 4-byte emoji it cuts
      rb.push(Buffer.from('😀', 'utf8'));
      expect(rb.byteLength).toBe(0);
      expect(rb.snapshot().length).toBe(0);
      // and it refills on the next push
      rb.push(Buffer.from('ab', 'utf8'));
      expect(rb.snapshot().toString('utf8')).toBe('ab');
    });

    it('whole-chunk eviction keeps characters intact', () => {
      const rb = new RingBuffer(10);
      rb.push(Buffer.from('日本語', 'utf8')); // 9 bytes
      rb.push(Buffer.from('😀😀', 'utf8')); // 8 bytes -> first chunk evicted
      const kept = rb.snapshot().toString('utf8');
      expect(kept).toBe('😀😀');
      expect(kept).not.toContain(REPLACEMENT);
    });
  });

  it('clear resets', () => {
    const rb = new RingBuffer(10);
    rb.push(Buffer.from('xyz'));
    rb.clear();
    expect(rb.byteLength).toBe(0);
    expect(rb.snapshot().length).toBe(0);
  });
});

describe('buildEnv', () => {
  it('always scrubs the S-01 landmines', () => {
    const env = buildEnv({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', KEEP: 'x' });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.KEEP).toBe('x');
  });

  it('applies deltas; undefined deletes', () => {
    const env = buildEnv({ A: '1', B: '2' }, { B: undefined, C: '3' });
    expect(env.A).toBe('1');
    expect('B' in env).toBe(false);
    expect(env.C).toBe('3');
  });
});
