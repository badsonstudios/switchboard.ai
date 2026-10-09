// How full a session's context window is (#715): reading the CLI's answer.
//
// The payloads are cut down from captures against the real CLI (2.1.288; see
// spike/findings/715-context-usage.md). What is pinned here is what the app
// does with them: the CLI's own percentage is used, only the numbers survive,
// and an answer with no usable fill is NOTHING rather than zero.
import { describe, it, expect } from 'vitest';
import {
  CONTEXT_FILLING_AT,
  CONTEXT_NEARLY_FULL_AT,
  contextLevel,
  getContextUsageRequest,
  readContextUsage,
} from './context-usage';

/** a cold Opus session, as captured: the scalars, and two of the bulky keys */
const COLD = {
  categories: [{ name: 'System prompt', tokens: 3341, color: 'promptBorder', kind: 'used' }],
  totalTokens: 36198,
  maxTokens: 1000000,
  rawMaxTokens: 1000000,
  autocompactSource: 'model-default',
  percentage: 4,
  model: 'claude-opus-5-5',
  memoryFiles: [{ path: 'C:\\Users\\someone\\.claude\\CLAUDE.md', type: 'User', tokens: 742 }],
  autoCompactThreshold: 967000,
  isAutoCompactEnabled: true,
  apiUsage: null,
};

describe('the request', () => {
  it('is the get_context_usage verb, with the id it was given', () => {
    expect(getContextUsageRequest('r-1')).toMatchObject({
      type: 'control_request',
      request_id: 'r-1',
      request: { subtype: 'get_context_usage' },
    });
  });
});

describe('reading a get_context_usage answer', () => {
  it('takes the CLI’s own percentage and the three counts', () => {
    expect(readContextUsage(COLD)).toEqual({
      percentage: 4,
      totalTokens: 36198,
      maxTokens: 1000000,
      autoCompactAt: 967000,
    });
  });

  it('carries ONLY the numbers: no file path from the user’s machine crosses', () => {
    const read = readContextUsage(COLD)!;
    expect(Object.keys(read).sort()).toEqual([
      'autoCompactAt',
      'maxTokens',
      'percentage',
      'totalTokens',
    ]);
    expect(JSON.stringify(read)).not.toContain('CLAUDE.md');
  });

  it('follows the window of the model the session is on', () => {
    // the same session after `set_model haiku`, as captured
    expect(
      readContextUsage({ ...COLD, totalTokens: 35607, maxTokens: 200000, percentage: 18, autoCompactThreshold: 167000 })
    ).toMatchObject({ percentage: 18, maxTokens: 200000, autoCompactAt: 167000 });
  });

  it('says no compaction point when auto-compact is off, or the CLI did not say', () => {
    expect(readContextUsage({ ...COLD, isAutoCompactEnabled: false })!.autoCompactAt).toBeNull();
    expect(readContextUsage({ ...COLD, autoCompactThreshold: undefined })!.autoCompactAt).toBeNull();
    // only `true` counts: a truthy string is not the CLI saying it is on
    expect(readContextUsage({ ...COLD, isAutoCompactEnabled: 'yes' })!.autoCompactAt).toBeNull();
  });

  it('works the percentage out from the two counts only when the CLI left it out', () => {
    expect(readContextUsage({ totalTokens: 150000, maxTokens: 200000 })).toMatchObject({ percentage: 75 });
    // the CLI's own figure wins when both are there
    expect(readContextUsage({ totalTokens: 150000, maxTokens: 200000, percentage: 74 })).toMatchObject({
      percentage: 74,
    });
  });

  it('⚠️ an answer with no usable fill is NOTHING, never zero', () => {
    expect(readContextUsage({})).toBeNull();
    expect(readContextUsage({ categories: [] })).toBeNull();
    expect(readContextUsage({ percentage: 'lots' })).toBeNull();
    expect(readContextUsage({ percentage: NaN })).toBeNull();
    expect(readContextUsage({ percentage: -3 })).toBeNull();
    expect(readContextUsage({ totalTokens: 10, maxTokens: 0 })).toBeNull();
    expect(readContextUsage({ totalTokens: 10 })).toBeNull();
  });

  it('keeps the figure inside 0 to 100 and whole', () => {
    expect(readContextUsage({ percentage: 140 })!.percentage).toBe(100);
    expect(readContextUsage({ percentage: 61.6 })!.percentage).toBe(62);
    expect(readContextUsage({ percentage: 0 })!.percentage).toBe(0);
  });

  it('a count the CLI got wrong is dropped, and the fill is still shown', () => {
    expect(readContextUsage({ percentage: 40, totalTokens: 'many', maxTokens: null })).toEqual({
      percentage: 40,
      totalTokens: null,
      maxTokens: null,
      autoCompactAt: null,
    });
  });
});

describe('the three states', () => {
  it('plain below 60, filling from 60, nearly full from 80', () => {
    expect(CONTEXT_FILLING_AT).toBe(60);
    expect(CONTEXT_NEARLY_FULL_AT).toBe(80);
    expect(contextLevel(0)).toBe('normal');
    expect(contextLevel(59)).toBe('normal');
    expect(contextLevel(60)).toBe('filling');
    expect(contextLevel(79)).toBe('filling');
    expect(contextLevel(80)).toBe('nearly-full');
    expect(contextLevel(100)).toBe('nearly-full');
  });
});
