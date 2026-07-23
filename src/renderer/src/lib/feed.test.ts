import { describe, it, expect } from 'vitest';
import { blockVisible, upsertBlock, FeedBlockDto } from './feed';

const b = (kind: FeedBlockDto['kind'], sidechain = false): FeedBlockDto => ({
  seq: 1,
  kind,
  sidechain,
});

const at = (seq: number): FeedBlockDto => ({ seq, kind: 'assistant', sidechain: false });

describe('upsertBlock (E10-06 re-emits; review P1 #14 ordering)', () => {
  it('replaces in place on a seq hit', () => {
    const out = upsertBlock([at(1), at(2)], { ...at(2), text: 'v2' });
    expect(out.map((x) => x.seq)).toEqual([1, 2]);
    expect(out[1].text).toBe('v2');
  });

  it('appends a new tail block', () => {
    expect(upsertBlock([at(1), at(2)], at(3)).map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it('a re-emit of an evicted (below-window) seq never renders as newest', () => {
    // window holds seqs 10..12 at cap 3; a re-emit of evicted seq 2 arrives
    const out = upsertBlock([at(10), at(11), at(12)], at(2), 3);
    // inserted in order, then capped away — NOT appended at the tail
    expect(out.map((x) => x.seq)).toEqual([10, 11, 12]);
  });

  it('an out-of-order arrival below cap is inserted by seq', () => {
    expect(upsertBlock([at(1), at(4)], at(3)).map((x) => x.seq)).toEqual([1, 3, 4]);
  });
});

describe('blockVisible (E12-07 verbosity presets)', () => {
  it('quiet: prose only, no sidechains', () => {
    expect(blockVisible(b('user'), 'quiet')).toBe(true);
    expect(blockVisible(b('assistant'), 'quiet')).toBe(true);
    expect(blockVisible(b('tool'), 'quiet')).toBe(false);
    expect(blockVisible(b('thinking'), 'quiet')).toBe(false);
    expect(blockVisible(b('assistant', true), 'quiet')).toBe(false);
  });

  it('normal: everything except thinking', () => {
    expect(blockVisible(b('tool'), 'normal')).toBe(true);
    expect(blockVisible(b('assistant', true), 'normal')).toBe(true);
    expect(blockVisible(b('thinking'), 'normal')).toBe(false);
  });

  it('firehose: everything', () => {
    expect(blockVisible(b('thinking'), 'firehose')).toBe(true);
    expect(blockVisible(b('tool', true), 'firehose')).toBe(true);
  });
});
