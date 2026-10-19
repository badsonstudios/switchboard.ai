// #1259 — the compaction mark, from both spellings of the CLI's frame.
import { describe, it, expect } from 'vitest';
import { compactionMark, compactionMarkOfEntry } from './compaction';

describe('compactionMark', () => {
  it('keeps the two triggers the CLI names, and real counts', () => {
    expect(compactionMark('manual', 32516, 4760)).toEqual({ trigger: 'manual', preTokens: 32516, postTokens: 4760 });
    expect(compactionMark('auto', 0, 0)).toEqual({ trigger: 'auto', preTokens: 0, postTokens: 0 });
  });

  it('drops what it cannot back, ABSENT rather than undefined-valued', () => {
    const m = compactionMark('later', '12', -1);
    expect(m).toEqual({});
    expect(Object.keys(m)).toEqual([]);
    expect(compactionMark(undefined, Number.NaN, Infinity)).toEqual({});
  });
});

describe('compactionMarkOfEntry', () => {
  it('reads the transcript line, camelCase (measured, CLI 2.1.288)', () => {
    expect(
      compactionMarkOfEntry({
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 969261, postTokens: 21286, cumulativeDroppedTokens: 947975 },
      })
    ).toEqual({ trigger: 'auto', preTokens: 969261, postTokens: 21286 });
  });

  it('reads the stream spelling too, as a guard on the same contract', () => {
    expect(
      compactionMarkOfEntry({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 32516, post_tokens: 4760 },
      })
    ).toEqual({ trigger: 'manual', preTokens: 32516, postTokens: 4760 });
  });

  it('a boundary with no metadata is still a boundary (fail-open)', () => {
    expect(compactionMarkOfEntry({ type: 'system', subtype: 'compact_boundary' })).toEqual({});
  });

  it('anything else is not one', () => {
    expect(compactionMarkOfEntry({ type: 'system', subtype: 'init' })).toBeNull();
    expect(compactionMarkOfEntry({ type: 'user', subtype: 'compact_boundary' })).toBeNull();
  });
});
