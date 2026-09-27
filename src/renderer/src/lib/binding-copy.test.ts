// P2-E15-10: what an empty Session view says, tested without React.
//
// The done-when is a UI claim — "the Session view distinguishes waiting for the
// first prompt, waiting for transcript, and couldn't bind, and says which" —
// so the rule that decides it lives in a pure function and is asserted here
// rather than through a rendered tree.
import { describe, it, expect } from 'vitest';
import { emptyStateCopy } from './binding-copy';
import en from '../../../shared/i18n/locales/en.json';
import type { BindingDiagnostics } from '../../../shared/transcripts';
import type { TransportKind } from '../../../shared/transport';

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

// #447 — the fail-open line is the one sentence in this rule that is not true
// on both transports, and it used to be printed on both. Reported by #418's
// worker from `binding.spec.ts`: two honest strings composing into a lie, the
// same defect class as #261's handoff bar one surface over.
// #447 — the fail-open line. It used to FOLLOW THE TRANSPORT; there is one
// transport since #952, so it is one line.
describe('the fail-open line', () => {
  const fallback = (transport?: TransportKind): string | null =>
    emptyStateCopy('unbound', diag(), transport).fallback;

  it('only the problem state gets one at all', () => {
    // Nothing has gone wrong, so there is nothing to reassure anyone about —
    // and a reassurance under "No conversation yet" would invent an alarm.
    for (const st of ['awaiting-prompt', 'searching', 'bound'] as const) {
      expect(emptyStateCopy(st, diag(), 'stream').fallback).toBeNull();
    }
    expect(emptyStateCopy('unbound', diag(), 'stream').fallback).toBeTruthy();
  });

  // Two tests stood here: one pinned that a PTY session was sent to the Terminal
  // and a Direct one nowhere, and one pinned that an UNRESOLVED transport
  // defaulted to the Terminal wording — the safe default at the time, because the
  // Direct line shown to a PTY user would have denied a terminal that was sitting
  // right there with the session running in it.
  //
  // Neither risk exists now, and the unresolved case is the one that matters: a
  // card restored from the workspace file renders this panel before its transport
  // is known, and it must get the true line rather than a legacy one.
  it('says the same true thing whether or not the transport is known yet', () => {
    expect(fallback('stream')).toBe('binding.unboundFallbackDirect');
    expect(fallback(undefined)).toBe('binding.unboundFallbackDirect');
  });

  // The keys above are indirection; these two sentences are what a user reads,
  // and the bug was IN THE WORDS. Pin both.
  const strings = en.binding as Record<string, string>;

  // The PTY wording's own test went with the string (#952). It had already been
  // rewritten once: it read "The Terminal tab is unaffected — your session is
  // still running there", and #873 removed the destination it named.
  it('the Direct wording never sends anyone to a terminal that does not exist', () => {
    const direct = strings.unboundFallbackDirect;
    expect(direct).toBeTruthy();
    // The exact failure #447 reports: the Terminal tab of a Direct session
    // holds `terminal.streamTitle` — "No terminal for this session".
    expect(direct.toLowerCase()).not.toContain('terminal');
    // ...and it still does the job the line exists for — saying the session
    // itself is fine (fail-open, said out loud).
    expect(direct.toLowerCase()).toContain('unaffected');
  });
});
