import { describe, it, expect } from 'vitest';
import {
  dropAnswered,
  dropRetired,
  enqueueHeld,
  IncomingPermission,
  intakePermission,
} from './held-permissions';
import { terminalHandoff } from './terminal-handoff';

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

// P2-E9-11 — the pop, once the rendered head stopped being the raw head.
//
// The bar used to render `permQueue[0]` and pop `slice(1)`, which agreed
// because they were the same expression twice. §5.8's grouped prompt filters
// the batched requests out of the bar, so the two can now name DIFFERENT
// entries — and the positional pop would then answer the one the user clicked
// while deleting one that is still held.
describe('dropAnswered — taking the answered request out of the bar (P2-E9-11)', () => {
  const held = (requestId: string, sessionId = 'live-A') => ({ requestId, sessionId });

  it('removes the answered request and nothing else', () => {
    const queue = [held('perm-1'), held('perm-2'), held('perm-3')];
    expect(dropAnswered(queue, 'perm-2')).toEqual([held('perm-1'), held('perm-3')]);
  });

  it('keeps a request that is NOT the head — the whole point of the change', () => {
    // perm-1 is on the grouped card, so the bar's head is perm-2. A positional
    // pop here would answer perm-2 and delete perm-1, which the CLI is still
    // parked on and which nothing would ever show again.
    const queue = [held('perm-1'), held('perm-2')];
    expect(dropAnswered(queue, 'perm-2')).toEqual([held('perm-1')]);
  });

  it('hands back the SAME array when the id is not there', () => {
    // a redelivered resolution must not cost a re-render
    const queue = [held('perm-1')];
    expect(dropAnswered(queue, 'perm-9')).toBe(queue);
  });
});

// #310 — what the card DOES with an inbound request, allow-all included.
//
// This is the handler that shipped the bug, and it shipped it because it was
// unreachable from a test: it lived inside a SessionGrid effect, and SessionGrid
// needs a live dockview to mount. `terminal-handoff.test.ts` proved the BAR's
// rule the whole time; nothing proved what the intake told the bar.
describe('intakePermission — the card taking one request (issue 310)', () => {
  const incoming = (over: Partial<IncomingPermission> = {}): IncomingPermission => ({
    requestId: 'stream:live-A:req-1',
    sessionId: 'live-A',
    cardId: 'card-1',
    tool: 'Write',
    input: { file_path: 'C:/proj/.claude/scripts/coverage.sh' },
    reason: 'which is a sensitive file.',
    ...over,
  });

  /** the card's ports, all recording, with allow-all off unless asked */
  function ports(allowAll: string[] = []) {
    const calls = {
      decided: [] as Array<{ requestId: string; decision: string }>,
      queued: [] as IncomingPermission[],
      surfaced: 0,
      suppressed: 0,
    };
    return {
      calls,
      port: {
        isAllowAll: (sessionId: string) => allowAll.includes(sessionId),
        decide: (requestId: string, decision: 'allow') =>
          calls.decided.push({ requestId, decision }),
        queue: (r: IncomingPermission) => calls.queued.push(r),
        surface: () => calls.surfaced++,
        suppressHandoff: () => calls.suppressed++,
      },
    };
  }

  it('queues a request for a card that has not chosen allow-all, and shows it', () => {
    const { calls, port } = ports();
    intakePermission(incoming(), 'card-1', port);

    expect(calls.queued).toHaveLength(1);
    expect(calls.surfaced).toBe(1);
    expect(calls.decided).toEqual([]); // the USER answers this one
    expect(calls.suppressed).toBe(0); // …and nothing is being suppressed yet
  });

  it('passes the CLI\u2019s own fields through to the bar untouched', () => {
    const { calls, port } = ports();
    const r = incoming();
    intakePermission(r, 'card-1', port);
    expect(calls.queued[0]).toBe(r);
  });

  it('ignores a request routed to a different card', () => {
    const { calls, port } = ports(['live-A']);
    intakePermission(incoming({ cardId: 'card-2' }), 'card-1', port);

    expect(calls).toMatchObject({ queued: [], decided: [], surfaced: 0, suppressed: 0 });
  });

  // THE BUG. Answering silently is right; answering silently and saying nothing
  // is what put a Direct session into `needs-permission` with no held approval —
  // the terminal-handoff bar's exact render condition — on every gated call.
  it('auto-allows for an allow-all session AND suppresses the handoff bar', () => {
    const { calls, port } = ports(['live-A']);
    intakePermission(incoming(), 'card-1', port);

    expect(calls.decided).toEqual([{ requestId: 'stream:live-A:req-1', decision: 'allow' }]);
    expect(calls.suppressed).toBe(1);
  });

  it('an auto-allow raises no bar and steals no tab', () => {
    const { calls, port } = ports(['live-A']);
    intakePermission(incoming(), 'card-1', port);

    // the point of allow-all: no hold, no bar, no view change (P2 #19)
    expect(calls.queued).toEqual([]);
    expect(calls.surfaced).toBe(0);
  });

  // Allow-all is keyed by LIVE session id so a respawn asks again (E10-04
  // review P0#2). A second session on the same card must not inherit it.
  it('allow-all is per live session, not per card', () => {
    const { calls, port } = ports(['live-A']);
    intakePermission(incoming({ sessionId: 'live-B', requestId: 'stream:live-B:req-1' }), 'card-1', port);

    expect(calls.decided).toEqual([]);
    expect(calls.queued).toHaveLength(1);
    expect(calls.suppressed).toBe(0);
  });

  // Every gated call in an allow-all session lands here, and every one of them
  // has to re-open the window: a suppression that only fired once would let the
  // bar back in on call two, which is exactly what Dan saw repeat.
  it('suppresses on EVERY auto-allow, not just the first', () => {
    const { calls, port } = ports(['live-A']);
    intakePermission(incoming({ requestId: 'r1' }), 'card-1', port);
    intakePermission(incoming({ requestId: 'r2' }), 'card-1', port);
    intakePermission(incoming({ requestId: 'r3' }), 'card-1', port);

    expect(calls.decided.map((d) => d.requestId)).toEqual(['r1', 'r2', 'r3']);
    expect(calls.suppressed).toBe(3);
  });
});

// …and the bar's own rule, restated against the state the intake now leaves
// behind. `terminal-handoff.test.ts` owns `terminalHandoff` in full; this is the
// JOIN — the one thing neither file could see on its own (#310).
describe('the intake leaves no window the handoff bar can open in (issue 310)', () => {
  it('an auto-allowed request never produces needs-permission with nothing held', () => {
    const suppressed: boolean[] = [];
    intakePermission(
      {
        requestId: 'stream:live-A:req-1',
        sessionId: 'live-A',
        cardId: 'card-1',
        tool: 'Write',
        input: {},
      },
      'card-1',
      {
        isAllowAll: () => true,
        decide: () => {},
        queue: () => {},
        surface: () => {},
        suppressHandoff: () => suppressed.push(true),
      }
    );

    // main has already applied `permission-held`, so this is the status the
    // card is sitting on when the intake runs, and nothing is queued
    expect(
      terminalHandoff({
        status: 'needs-permission',
        hasApproval: false,
        startingLong: false,
        recentlyDecided: suppressed.length > 0,
        // NOT 'stream' on purpose: the transport prop is #261's fix, on another
        // branch. If this passes with the transport unknown, the suppression is
        // carrying it on its own — an independent guard, not a duplicate of one.
        transport: undefined,
      })
    ).toBeNull();
  });

  // The PTY behaviour #125 exists for, asserted right beside it so a future
  // edit to the intake cannot quietly take it away. A PTY session never reaches
  // the auto-allow branch (its allow-all is answered at the server, so no
  // request is pushed), and a CLI-kept prompt still gets its bar.
  it('a PTY session with a CLI-kept prompt still gets the handoff bar', () => {
    expect(
      terminalHandoff({
        status: 'needs-permission',
        hasApproval: false,
        startingLong: false,
        recentlyDecided: false,
        transport: 'pty',
      })
    ).toMatchObject({ title: 'handoff.permissionTitle', tone: 'permission' });
  });
});

// #310 — the last piece of the intake a test could not reach.
//
// The field-by-field mapping lived inside the SessionGrid effect, with a comment
// admitting that forgetting a field is silent and that `reason` had been lost
// exactly that way once, caught only by an e2e. Extracting it makes the comment
// enforceable.
describe('enqueueHeld — building the review queue (issue 310)', () => {
  const wire = (over: Partial<IncomingPermission> = {}): IncomingPermission => ({
    requestId: 'stream:live-A:req-1',
    sessionId: 'live-A',
    cardId: 'card-1',
    tool: 'Write',
    input: { file_path: 'C:/proj/.claude/settings.json', content: '{}' },
    reason: 'Claude requested permissions to edit it, which is a sensitive file.',
    ...over,
  });

  it('carries every field the bar renders, the CLI’s reason included', () => {
    const [entry] = enqueueHeld([], wire());

    expect(entry).toEqual({
      requestId: 'stream:live-A:req-1',
      sessionId: 'live-A',
      tool: 'Write',
      input: { file_path: 'C:/proj/.claude/settings.json', content: '{}' },
      reason: 'Claude requested permissions to edit it, which is a sensitive file.',
    });
  });

  it('does not carry the routing field — cardId is the envelope, not the question', () => {
    expect(enqueueHeld([], wire())[0]).not.toHaveProperty('cardId');
  });

  it('a hook request with no reason queues cleanly', () => {
    // the PTY half has no equivalent of `decision_reason`; undefined is correct
    expect(enqueueHeld([], wire({ reason: undefined }))[0].reason).toBeUndefined();
  });

  it('appends: parallel tool calls each keep their own request (E10-04 P0#4)', () => {
    const first = enqueueHeld([], wire({ requestId: 'r1' }));
    const both = enqueueHeld(first, wire({ requestId: 'r2' }));

    expect(both.map((h) => h.requestId)).toEqual(['r1', 'r2']);
    expect(both[0]).toBe(first[0]); // the queued one is untouched
  });

  it('a redelivered request returns the SAME array — no bar flicker, no re-render', () => {
    const queue = enqueueHeld([], wire({ requestId: 'r1' }));
    expect(enqueueHeld(queue, wire({ requestId: 'r1' }))).toBe(queue);
  });
});
