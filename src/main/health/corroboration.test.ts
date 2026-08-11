// P2-E14-07: the local rule — "several sessions erroring at once" — as a table.
//
// The thresholds are NAMED constants with an argued rationale (see the file
// under test), and these cases pin the argument: one session is never enough,
// three is, recovery clears it at once, and time clears it on its own.
import { describe, it, expect } from 'vitest';
import {
  CORROBORATION_MIN_SESSIONS,
  CORROBORATION_WINDOW_MS,
  CorroborationTracker,
  turnOutcome,
} from './corroboration';

const T0 = 1_000_000;

describe('the thresholds are decisions, not accidents', () => {
  it('is three sessions in five minutes', () => {
    // If either of these moves, the reasoning in corroboration.ts moves with
    // it — that is what this case is for.
    expect(CORROBORATION_MIN_SESSIONS).toBe(3);
    expect(CORROBORATION_WINDOW_MS).toBe(5 * 60_000);
  });
});

describe('raising', () => {
  it('does not raise on one session, however loudly it fails', () => {
    const t = new CorroborationTracker();
    for (let i = 0; i < 20; i++) t.noteError('a', T0 + i * 100);
    expect(t.evaluate(T0 + 2_000)).toEqual({ raised: false, sessions: 1 });
  });

  it('does not raise on two', () => {
    const t = new CorroborationTracker();
    t.noteError('a', T0);
    t.noteError('b', T0 + 1_000);
    expect(t.evaluate(T0 + 2_000).raised).toBe(false);
  });

  it('raises on three distinct sessions inside the window', () => {
    const t = new CorroborationTracker();
    t.noteError('a', T0);
    t.noteError('b', T0 + 60_000);
    t.noteError('c', T0 + 120_000);
    const v = t.evaluate(T0 + 130_000);
    expect(v.raised).toBe(true);
    expect(v.sessions).toBe(3);
    // "since" is the OLDEST error still standing. Main-side only: it is not on
    // the record that crosses IPC, because no surface renders it (§5.29 — a
    // field nobody draws is a field that should not travel).
    expect(v.since).toBe(new Date(T0).toISOString());
  });

  it('does not raise when the three are spread beyond the window', () => {
    const t = new CorroborationTracker();
    t.noteError('a', T0);
    t.noteError('b', T0 + 4 * 60_000);
    t.noteError('c', T0 + 9 * 60_000);
    // by the time c fails, a is 9 minutes old and gone
    expect(t.evaluate(T0 + 9 * 60_000).raised).toBe(false);
  });
});

describe('clearing', () => {
  it('clears the moment one of them completes a turn', () => {
    const t = new CorroborationTracker();
    for (const id of ['a', 'b', 'c']) t.noteError(id, T0);
    expect(t.evaluate(T0).raised).toBe(true);
    t.noteRecovery('b');
    expect(t.evaluate(T0 + 1_000)).toEqual({ raised: false, sessions: 2 });
  });

  it('clears on its own when the window passes', () => {
    const t = new CorroborationTracker();
    for (const id of ['a', 'b', 'c']) t.noteError(id, T0);
    expect(t.evaluate(T0 + CORROBORATION_WINDOW_MS - 1).raised).toBe(true);
    expect(t.evaluate(T0 + CORROBORATION_WINDOW_MS)).toEqual({ raised: false, sessions: 0 });
  });

  it('a session that keeps failing keeps its own evidence fresh', () => {
    const t = new CorroborationTracker();
    t.noteError('a', T0);
    t.noteError('b', T0);
    t.noteError('c', T0);
    t.noteError('a', T0 + 4 * 60_000);
    // a is fresh; b and c have aged out, so two thirds of the evidence is gone
    expect(t.evaluate(T0 + 5 * 60_000)).toEqual({ raised: false, sessions: 1 });
  });

  it('forgets a closed session', () => {
    const t = new CorroborationTracker();
    for (const id of ['a', 'b', 'c']) t.noteError(id, T0);
    t.forget('c');
    expect(t.evaluate(T0).raised).toBe(false);
  });

  it('takes injected thresholds, so a test need not sit through five minutes', () => {
    const t = new CorroborationTracker({ minSessions: 2, windowMs: 1_000 });
    t.noteError('a', T0);
    t.noteError('b', T0);
    expect(t.evaluate(T0).raised).toBe(true);
    expect(t.evaluate(T0 + 1_000).raised).toBe(false);
  });
});

describe('what counts as an error', () => {
  it('reads the two fields the protocol documents', () => {
    expect(turnOutcome({ type: 'result', is_error: true })).toBe(true);
    expect(turnOutcome({ type: 'result', subtype: 'error_during_execution' })).toBe(true);
    expect(turnOutcome({ type: 'result', subtype: 'error_max_turns' })).toBe(true);
  });

  it('a clean result is a recovery', () => {
    expect(turnOutcome({ type: 'result', subtype: 'success', is_error: false })).toBe(false);
  });

  it('everything else is not a verdict at all', () => {
    // null, not false: a stream_event must not be able to CLEAR the evidence,
    // which is what returning false here would mean
    expect(turnOutcome({ type: 'stream_event' })).toBeNull();
    expect(turnOutcome({ type: 'assistant' })).toBeNull();
    expect(turnOutcome({ type: 'rate_limit_event' })).toBeNull();
    expect(turnOutcome(null)).toBeNull();
    expect(turnOutcome('result')).toBeNull();
  });
});
