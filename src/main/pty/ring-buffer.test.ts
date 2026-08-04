import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ring-buffer';
import { buildEnv } from './pty-service';

// U+FFFD, built rather than typed so no source encoding can hide it
const REPLACEMENT = String.fromCharCode(0xfffd);

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
        // byteLength must agree with what snapshot() hands out. NOTE: this
        // holds because `text` contains neither ESC nor LF, so the #211 resume
        // alignment below is a no-op here — put a `\n` in the fixture and this
        // line starts failing for a reason that has nothing to do with #205.
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

  // #211: character alignment is not SEQUENCE alignment — a cut can land inside
  // `\x1b[38;5;10m`, and xterm renders the orphaned tail as literal text, so a
  // replay opens with visible residue.
  describe('resumes on an escape-sequence boundary (#211)', () => {
    const ESC = '\x1b';
    const BEL = '\x07';

    // the head of a replay is always safe to hand to a terminal: empty, a fresh
    // ESC, or the first byte of a line whose predecessor ended with LF
    const startsSafely = (kept: string, everythingPushed: string) =>
      kept === '' || kept.startsWith(ESC) || everythingPushed.includes(`\n${kept}`);

    it('whole-chunk eviction: SGR colour cut in half', () => {
      const rb = new RingBuffer(20);
      rb.push(Buffer.from(`padding${ESC}[38;5;`, 'utf8')); // chunk ends mid-CSI
      rb.push(Buffer.from('10mgreen text\nnext line\n', 'utf8')); // evicts chunk 1
      const kept = rb.snapshot().toString('utf8');

      expect(kept).not.toContain('10m'); // the residue is what the user saw
      expect(kept).toBe('next line\n'); // dropped exactly the orphaned line
      expect(startsSafely(kept, `padding${ESC}[38;5;10mgreen text\nnext line\n`)).toBe(true);
    });

    it('prefers a nearer ESC to the next newline, so it drops less', () => {
      const rb = new RingBuffer(40);
      rb.push(Buffer.from(`padding${ESC}[38;5;`, 'utf8'));
      rb.push(Buffer.from(`10mgreen ${ESC}[0mplain\nnext line\n`, 'utf8'));
      const kept = rb.snapshot().toString('utf8');

      expect(kept).toBe(`${ESC}[0mplain\nnext line\n`); // resumed at the ESC
      expect(kept).not.toContain('10m');
      expect(kept.startsWith(ESC)).toBe(true);
    });

    it('whole-chunk eviction: cursor move cut in half', () => {
      const rb = new RingBuffer(24);
      rb.push(Buffer.from(`${ESC}[2J${ESC}[12`, 'utf8')); // mid CUP params
      rb.push(Buffer.from(';40Hstatus\nready\n', 'utf8'));
      const kept = rb.snapshot().toString('utf8');

      expect(kept).not.toContain(';40H');
      expect(kept).toBe('ready\n');
    });

    it('whole-chunk eviction: OSC title cut in half, orphan BEL dropped', () => {
      const rb = new RingBuffer(28);
      rb.push(Buffer.from(`${ESC}]0;my ses`, 'utf8')); // mid OSC string
      rb.push(Buffer.from(`sion title${BEL}$ ls\ndocs  src\n`, 'utf8'));
      const kept = rb.snapshot().toString('utf8');

      expect(kept).not.toContain(BEL); // an orphan BEL would ring the bell
      expect(kept).not.toContain('title');
      expect(kept).toBe('docs  src\n');
    });

    it('oversized-chunk trim: cut lands inside a colour sequence', () => {
      // 21 bytes; a 15-byte cap cuts at byte 6 — inside `\x1b[38;5;10m`
      const payload = `${ESC}[38;5;10mHELLO\nworld`;
      expect(payload.length).toBe(21);
      const rb = new RingBuffer(15);
      rb.push(Buffer.from(payload, 'utf8'));
      const kept = rb.snapshot().toString('utf8');

      // the raw cut keeps `;10mHELLO\nworld` — the `;10m` is the residue
      expect(kept).not.toContain(';10m');
      expect(kept).toBe('world');
    });

    it('resumes at an ST-terminated OSC without waiting for a newline', () => {
      // the ESC anchor doing the work alone: no LF anywhere in what we keep.
      // `ESC \` (ST) at the head is a no-op in xterm.js, so it renders nothing.
      const rb = new RingBuffer(20);
      rb.push(Buffer.from(`${ESC}]0;my ses`, 'utf8'));
      rb.push(Buffer.from(`sion${ESC}\\prompt$ `, 'utf8')); // evicts chunk 1
      const kept = rb.snapshot().toString('utf8');

      expect(kept).toBe(`${ESC}\\prompt$ `);
      expect(kept).not.toContain('sion');
    });

    it('an already-safe head after a discard is left exactly as it is', () => {
      const rb = new RingBuffer(12);
      rb.push(Buffer.from('a'.repeat(12), 'utf8'));
      rb.push(Buffer.from(`${ESC}[0mhi`, 'utf8')); // evicts chunk 1, head is an ESC
      expect(rb.snapshot().toString('utf8')).toBe(`${ESC}[0mhi`);
      expect(rb.byteLength).toBe(6);
    });

    it('byteLength counts retained bytes; snapshot() can hand out fewer', () => {
      const rb = new RingBuffer(20);
      rb.push(Buffer.from('a'.repeat(20), 'utf8'));
      rb.push(Buffer.from('xx\nyy', 'utf8')); // evicts chunk 1
      expect(rb.byteLength).toBe(5); // what counts against the cap
      expect(rb.snapshot().toString('utf8')).toBe('yy'); // what a replay gets
    });

    it('no anchor ⇒ residue is kept rather than emptying the replay (known gap)', () => {
      const rb = new RingBuffer(10);
      rb.push(Buffer.from('x'.repeat(10), 'utf8'));
      rb.push(Buffer.from('50%\r75%\r', 'utf8')); // a \r-only progress meter
      expect(rb.snapshot().toString('utf8')).toBe('50%\r75%\r');
    });

    it('nothing discarded ⇒ nothing skipped, even if the text looks like residue', () => {
      const rb = new RingBuffer(100);
      rb.push(Buffer.from('38;5;10m is just text here\n', 'utf8'));
      expect(rb.snapshot().toString('utf8')).toBe('38;5;10m is just text here\n');
    });

    it('nothing discarded ⇒ a leading newline survives verbatim', () => {
      const rb = new RingBuffer(100);
      rb.push(Buffer.from('\nfirst\n', 'utf8'));
      expect(rb.snapshot().toString('utf8')).toBe('\nfirst\n');
    });

    it('no anchor at all ⇒ keeps everything rather than emptying the replay', () => {
      const rb = new RingBuffer(10);
      rb.push(Buffer.from('aaaaaaaaaa', 'utf8'));
      rb.push(Buffer.from('bbbbbbbbbb', 'utf8')); // evicts chunk 1
      expect(rb.snapshot().toString('utf8')).toBe('bbbbbbbbbb');
    });

    it('skipping the residue never re-breaks the #205 character guarantee', () => {
      const REPLACEMENT = String.fromCharCode(0xfffd);
      const tail = '10m😀 日本語 é\n😀 done\n'; // opens with residue, full of multi-byte
      const rb = new RingBuffer(Buffer.byteLength(tail, 'utf8'));
      rb.push(Buffer.from(`start${ESC}[38;5;`, 'utf8'));
      rb.push(Buffer.from(tail, 'utf8')); // evicts chunk 1
      const kept = rb.snapshot().toString('utf8');

      expect(kept).not.toContain(REPLACEMENT);
      expect(kept).not.toContain('10m');
      expect(kept).toBe('😀 done\n');
    });

    it('replays after many evictions always open safely', () => {
      const rb = new RingBuffer(64);
      let pushed = '';
      for (let i = 0; i < 50; i++) {
        const line = `${ESC}[38;5;${i}mline ${i}\n`;
        const at = 3 + (i % 9); // the split walks through the sequence
        rb.push(Buffer.from(line.slice(0, at), 'utf8'));
        rb.push(Buffer.from(line.slice(at), 'utf8'));
        pushed += line;
        expect(startsSafely(rb.snapshot().toString('utf8'), pushed)).toBe(true);
      }
    });

    it('clear() forgets that anything was discarded', () => {
      const rb = new RingBuffer(10);
      rb.push(Buffer.from('aaaaaaaaaa\n', 'utf8'));
      rb.push(Buffer.from('bbbbbbbbbb\n', 'utf8')); // discards
      rb.clear();
      rb.push(Buffer.from('38;5;10m\n', 'utf8')); // fresh stream: verbatim
      expect(rb.snapshot().toString('utf8')).toBe('38;5;10m\n');
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
