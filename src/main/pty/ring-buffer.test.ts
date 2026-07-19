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
