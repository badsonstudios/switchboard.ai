// P2-E15-10: what an empty Session view says, tested without React.
//
// The done-when is a UI claim — "the Session view distinguishes waiting for the
// first prompt, waiting for transcript, and couldn't bind, and says which" —
// so the rule that decides it lives in a pure function and is asserted here
// rather than through a rendered tree.
import { describe, it, expect } from 'vitest';
import { emptyStateCopy } from './binding-copy';
import type { BindingDiagnostics } from '../../../shared/transcripts';

const diag = (over: Partial<BindingDiagnostics> = {}): BindingDiagnostics => ({
  conversationStarted: false,
  candidateSeen: false,
  searchingMs: null,
  projectsRoot: 'C:/Users/x/.claude/projects',
  ...over,
});

describe('emptyStateCopy', () => {
  it('gives the three states three different headlines — the done-when', () => {
    const titles = (['awaiting-prompt', 'searching', 'unbound'] as const).map(
      (s) => emptyStateCopy(s, diag()).title
    );
    expect(new Set(titles).size).toBe(3);
  });

  it('only "unbound" reads as a problem', () => {
    expect(emptyStateCopy('awaiting-prompt', diag()).problem).toBe(false);
    expect(emptyStateCopy('searching', diag()).problem).toBe(false);
    expect(emptyStateCopy('bound', diag()).problem).toBe(false);
    expect(emptyStateCopy('unbound', diag()).problem).toBe(true);
  });

  it('a bound-but-silent session reads like an unprompted one, not an error', () => {
    // This function is only consulted when there is nothing to render, so
    // `bound` here means "tailing a file with no conversation in it yet" —
    // which is the same news the user needs as awaiting-prompt.
    expect(emptyStateCopy('bound', diag())).toEqual(emptyStateCopy('awaiting-prompt', diag()));
  });

  it('gives all FOUR evidence combinations their own diagnosis', () => {
    // Files-we-cannot-claim and no-turn-ever-reached-us are different failures
    // with different fixes; one "something went wrong" would send the reader
    // looking in the wrong place. The both-true case matters most — that a
    // turn ran is the single most triage-relevant fact on the screen, so it
    // must not be swallowed by the candidate message.
    const detail = (candidateSeen: boolean, conversationStarted: boolean) =>
      emptyStateCopy('unbound', diag({ candidateSeen, conversationStarted })).detail;
    const all = [detail(true, true), detail(true, false), detail(false, true), detail(false, false)];
    expect(new Set(all).size).toBe(4);
    expect(detail(true, true)).toBe('binding.unboundFound');
    expect(detail(true, false)).toBe('binding.unboundFoundQuiet');
    expect(detail(false, true)).toBe('binding.unboundSilent');
    expect(detail(false, false)).toBe('binding.unboundNothing');
  });

  it('always returns a detail line — a headline alone is the shrug this replaces', () => {
    for (const s of ['awaiting-prompt', 'searching', 'unbound', 'bound'] as const) {
      expect(emptyStateCopy(s, diag()).detail).toBeTruthy();
    }
  });

  it('survives a missing diagnostics object', () => {
    // The panel can render before the first snapshot arrives.
    expect(() => emptyStateCopy('unbound', null)).not.toThrow();
    expect(emptyStateCopy('unbound', null).detail).toBe('binding.unboundNothing');
  });
});
