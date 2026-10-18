// #1259 — the compaction divider's words. Only what the frame records is said.
import { describe, it, expect } from 'vitest';
import { compactionCopy } from './compaction-view';

describe('compactionCopy', () => {
  it('who asked, with the counts', () => {
    expect(compactionCopy({ trigger: 'manual', preTokens: 32516, postTokens: 4760 })).toEqual({
      key: 'feedView.compaction.manualTokens',
      vars: { pre: '33k', post: '4.8k' },
    });
    expect(compactionCopy({ trigger: 'auto', preTokens: 969261, postTokens: 21286 })).toEqual({
      key: 'feedView.compaction.autoTokens',
      vars: { pre: '969k', post: '21k' },
    });
    expect(compactionCopy({ preTokens: 1_240_000, postTokens: 900 })).toEqual({
      key: 'feedView.compaction.plainTokens',
      vars: { pre: '1.24M', post: '900' },
    });
  });

  it('no counts unless BOTH arrived — "32.5k → ?" would read as a fault', () => {
    expect(compactionCopy({ trigger: 'manual', preTokens: 32516 })).toEqual({ key: 'feedView.compaction.manual', vars: {} });
    expect(compactionCopy({ trigger: 'auto', postTokens: 10 })).toEqual({ key: 'feedView.compaction.auto', vars: {} });
  });

  it('a mark with nothing on it, or none at all, still says compacted', () => {
    expect(compactionCopy({})).toEqual({ key: 'feedView.compaction.plain', vars: {} });
    expect(compactionCopy(undefined)).toEqual({ key: 'feedView.compaction.plain', vars: {} });
  });
});
