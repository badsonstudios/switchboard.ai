// A `BusQueries` double, for tests that are not about the query core (#764).
//
// `BusQueries` is a `Pick` over `SessionQueries`, so widening it — which #764
// did, from one method to three — is a compile error at every stub in the
// suite. That is the property worth having: a method dropped from the query
// core cannot quietly become a tool that answers "unknown request" at runtime.
// What it should NOT cost is three files each growing two hand-written methods
// they do not exercise, drifting apart as the shapes change.
//
// So the DEFAULTS here are deliberately dull and deliberately succeed: a stub
// that refused by default would make every test that forgot to override it pass
// for the wrong reason. A test that cares about a refusal states it.
import type { BusQueries } from '../host-channel';
import type { SessionSummary } from '../../sessions/queries';

export const STUB_SESSIONS: SessionSummary[] = [
  { id: 'sb-caller', name: 'Alpha', folder: '/p/alpha', providerId: 'claude-code', status: 'working' },
  { id: 'sb-other', name: 'Beta', folder: '/p/beta', providerId: 'claude-code', status: 'idle' },
];

/**
 * Which session a stub answer is ABOUT — resolved, not hardcoded.
 *
 * Review of #764 caught the first version returning `STUB_SESSIONS[0]` — the
 * caller — whatever it was asked for. That makes "answered about the wrong
 * sibling" the stub's baseline behaviour, so a test that forgets to check
 * identity is not merely incomplete, it is built on a lie. Falls back to a
 * clearly-labelled unknown rather than to the caller, for the same reason.
 */
function subjectOf(ref: unknown): SessionSummary {
  // `String(ref)` on an object gives `[object Object]`, which is a real shape
  // here — the tools take whatever JSON a model wrote. Narrowed rather than
  // coerced so an unresolvable non-string reads as one.
  const needle = typeof ref === 'string' ? ref.replace(/^@/, '') : '';
  return (
    STUB_SESSIONS.find((s) => s.id === needle || s.name === needle) ?? {
      id: `unresolved:${needle}`,
      name: `unresolved:${needle}`,
      folder: '',
      providerId: 'claude-code',
      status: 'idle',
    }
  );
}

export function stubQueries(over: Partial<BusQueries> = {}): BusQueries {
  return {
    listSessions: () => ({ ok: true, value: STUB_SESSIONS }),
    // The answers ECHO their arguments, so a hop that drops one is visible in
    // the output rather than absorbed by a constant.
    sessionOutput: (ref, lastN) => ({
      ok: true,
      value: {
        session: subjectOf(ref),
        text: `output for ${String(ref)}${lastN === undefined ? '' : ` lastN=${String(lastN)}`}`,
        blocks: 1,
        truncated: false,
      },
    }),
    sessionDiff: (ref) =>
      Promise.resolve({
        ok: true,
        value: { session: subjectOf(ref), isRepo: true, diff: `diff for ${String(ref)}`, truncated: false },
      }),
    ...over,
  };
}
