// A held approval has a clock (#1202): who is waiting on one, how long is
// left, and when "nearly out" starts.
import { describe, it, expect } from 'vitest';
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import {
  APPROVAL_URGENT_MS,
  approvalAttrs,
  approvalTimeLeft,
  approvalWatch,
  earliestDeadline,
  NO_APPROVAL,
  waitingOnApproval,
} from './approval-watch';

const req = (patch: Partial<PermissionRequestDto>): PermissionRequestDto => ({
  requestId: 'r',
  sessionId: 's',
  tool: 'Bash',
  input: {},
  ...patch,
});

describe('who is waiting on an approval', () => {
  const sessions = [
    { id: 'a', status: 'needs-permission' },
    { id: 'b', status: 'needs-input' },
    { id: 'c', status: 'needs-permission' },
    { id: 'd', status: 'done' },
  ];

  it('is a session the COUNT lists AND whose status is needs-permission', () => {
    expect(waitingOnApproval(sessions, new Set(['a', 'b', 'c', 'd']))).toEqual(['a', 'c']);
  });

  it('never a session the count has stopped listing (the stale-flash class, #1137)', () => {
    // its status still says needs-permission, but nothing is listed for it:
    // the pulse must not claim an approval nobody is being shown
    expect(waitingOnApproval(sessions, new Set(['c']))).toEqual(['c']);
    expect(waitingOnApproval(sessions, new Set())).toEqual([]);
  });

  it('a question is lit elsewhere, but has no clock and does not pulse', () => {
    expect(waitingOnApproval([{ id: 'b', status: 'needs-input' }], new Set(['b']))).toEqual([]);
  });
});

describe('the soonest deadline', () => {
  it('is taken across the cards asked about, and only those', () => {
    const pending = [
      req({ requestId: '1', cardId: 'a', deadline: 5000 }),
      req({ requestId: '2', cardId: 'a', deadline: 3000 }),
      req({ requestId: '3', cardId: 'z', deadline: 1000 }),
    ];
    expect(earliestDeadline(pending, new Set(['a']))).toBe(3000);
    expect(earliestDeadline(pending, new Set(['a', 'z']))).toBe(1000);
  });

  it('is null with nothing held, a question (no deadline), or a request no card owns', () => {
    expect(earliestDeadline([], new Set(['a']))).toBeNull();
    expect(earliestDeadline([req({ cardId: 'a' })], new Set(['a']))).toBeNull();
    expect(earliestDeadline([req({ deadline: 9 })], new Set(['a']))).toBeNull();
    expect(earliestDeadline([req({ cardId: 'a', deadline: Number.NaN })], new Set(['a']))).toBeNull();
  });
});

describe('the state of the cue', () => {
  const now = 1_000_000;

  it('nothing waiting: no cue at all', () => {
    expect(approvalWatch(false, now + 5000, now)).toBe(NO_APPROVAL);
    expect(approvalAttrs(NO_APPROVAL)).toEqual({
      'data-needs-approval': undefined,
      'data-approval-urgent': undefined,
    });
  });

  it('waiting with time in hand: on, not urgent, and the time is known', () => {
    const w = approvalWatch(true, now + 200_000, now);
    expect(w).toEqual({ active: true, urgent: false, leftMs: 200_000 });
    expect(approvalAttrs(w)['data-approval-urgent']).toBeUndefined();
  });

  it('the last minute is urgent, from exactly a minute out', () => {
    expect(approvalWatch(true, now + APPROVAL_URGENT_MS + 1, now).urgent).toBe(false);
    const w = approvalWatch(true, now + APPROVAL_URGENT_MS, now);
    expect(w.urgent).toBe(true);
    expect(approvalAttrs(w)).toEqual({
      'data-needs-approval': 'true',
      'data-approval-urgent': 'true',
    });
  });

  it('waiting with no deadline known: on, steady, and no clock is invented', () => {
    expect(approvalWatch(true, null, now)).toEqual({ active: true, urgent: false, leftMs: null });
  });

  it('a deadline already passed shows no clock and no urgency', () => {
    // main has declined it by now; "0 seconds left" would describe nothing
    expect(approvalWatch(true, now - 1, now)).toEqual({ active: true, urgent: false, leftMs: null });
    expect(approvalWatch(true, now, now).leftMs).toBeNull();
  });
});

describe('the time left, in words', () => {
  it('a bound it can state as "less than": whole minutes, rounded up', () => {
    expect(approvalTimeLeft(300_000)).toEqual({ unit: 'minutes', count: 5 });
    expect(approvalTimeLeft(240_001)).toEqual({ unit: 'minutes', count: 5 });
    expect(approvalTimeLeft(60_001)).toEqual({ unit: 'minutes', count: 2 });
  });

  it('tens of seconds in the last minute, never zero', () => {
    expect(approvalTimeLeft(60_000)).toEqual({ unit: 'seconds', count: 60 });
    expect(approvalTimeLeft(41_000)).toEqual({ unit: 'seconds', count: 50 });
    expect(approvalTimeLeft(1)).toEqual({ unit: 'seconds', count: 10 });
  });
});
