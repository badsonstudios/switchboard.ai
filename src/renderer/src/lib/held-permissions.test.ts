import { describe, it, expect } from 'vitest';
import { dropRetired } from './held-permissions';

// A stand-in for the card's queue entries: only `sessionId` is load-bearing,
// and the rule must carry the rest through untouched — a request is a question
// the CLI is blocked on, not a summary of one.
const hold = (requestId: string, sessionId: string) => ({
  requestId,
  sessionId,
  tool: 'Edit',
  input: { file_path: `C:/${requestId}.ts` },
});

describe('dropRetired — the queue rule when a session ends (issue 239)', () => {
  it("drops every hold the retired session raised, and only that session's", () => {
    const queue = [hold('perm-1', 'live-A'), hold('perm-2', 'live-B'), hold('perm-3', 'live-A')];

    const next = dropRetired(queue, 'live-A');

    // the other card's session is still blocked on its question
    expect(next).toEqual([hold('perm-2', 'live-B')]);
  });

  it('carries the surviving entries through by reference, fields intact', () => {
    // the bar renders the tool input and the CLI's own reason out of these; a
    // rule that rebuilt them would be a place for a field to go missing, which
    // is exactly how `reason` was lost once already
    const survivor = hold('perm-2', 'live-B');
    const next = dropRetired([hold('perm-1', 'live-A'), survivor], 'live-A');
    expect(next[0]).toBe(survivor);
  });

  it('returns the SAME array when nothing matched', () => {
    // every mounted card hears about every retirement, so the no-op case is the
    // common one: a fresh array here would be a state change — and a re-render
    // — per card per teardown
    const queue = [hold('perm-1', 'live-A')];
    expect(dropRetired(queue, 'live-Z')).toBe(queue);
    const empty: Array<{ sessionId: string }> = [];
    expect(dropRetired(empty, 'live-A')).toBe(empty); // identity, not just ==
  });

  it('empties a queue whose every hold belonged to the retired session', () => {
    const next = dropRetired([hold('perm-1', 'live-A'), hold('perm-2', 'live-A')], 'live-A');
    expect(next).toEqual([]);
  });

  it('matches on the SESSION id, never the request id', () => {
    // the two live side by side on every entry, and a rule that confused them
    // would drop one arbitrary hold and keep the dead session's others
    const queue = [hold('live-A', 'live-B')]; // a requestId that looks like the dead id
    expect(dropRetired(queue, 'live-A')).toBe(queue);
  });
});
