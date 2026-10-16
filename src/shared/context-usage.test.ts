// How full a session's context window is (#715): the neutral grading the
// meter draws. Claude's reader is pinned in
// `main/providers/claude-context-usage.test.ts`.
import { describe, it, expect } from 'vitest';
import { CONTEXT_FILLING_AT, CONTEXT_NEARLY_FULL_AT, contextLevel } from './context-usage';

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
