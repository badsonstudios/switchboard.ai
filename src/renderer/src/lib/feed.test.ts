import { describe, it, expect } from 'vitest';
import { blockVisible, FeedBlockDto } from './feed';

const b = (kind: FeedBlockDto['kind'], sidechain = false): FeedBlockDto => ({
  seq: 1,
  kind,
  sidechain,
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
