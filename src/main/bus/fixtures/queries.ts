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
import { Blackboard } from '../../sessions/blackboard';
import type { BusQueries } from '../host-channel';
import type { SessionSummary } from '../../sessions/queries';
import type { BusDelivery } from '../../sessions/delivery';

export const STUB_SESSIONS: SessionSummary[] = [
  { id: 'sb-caller', name: 'Alpha', folder: '/p/alpha', providerId: 'claude-code', status: 'working', exited: false },
  { id: 'sb-other', name: 'Beta', folder: '/p/beta', providerId: 'claude-code', status: 'idle', exited: false },
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
      exited: false,
    }
  );
}

/**
 * A `BusDelivery` double (#765), in the same spirit as `stubQueries`: dull, and
 * SUCCEEDING by default, so a test that is not about sending cannot pass for
 * the wrong reason on a refusal it never asked for. It echoes its arguments
 * into the receipt for the same reason the query stubs do — a hop that drops
 * one is then visible in the output — and records every call.
 */
export function stubDelivery(
  over: Partial<BusDelivery> = {}
): BusDelivery & { calls: { callerId: string; ref: unknown; message: unknown }[] } {
  const calls: { callerId: string; ref: unknown; message: unknown }[] = [];
  return {
    calls,
    send: (callerId, ref, message) => {
      calls.push({ callerId, ref, message });
      return Promise.resolve({
        ok: true,
        value: { session: subjectOf(ref), outcome: 'held', shown: true },
      });
    },
    ...over,
  };
}

/**
 * A real `Blackboard` over a stub session list (#796).
 *
 * NOT a hand-written fake, deliberately — unlike the queries above. The
 * blackboard's whole substance IS its policy (caps, overwrite, the miss that
 * names real keys), so a fake would be a reimplementation of the thing under
 * test, which is the "fixture built from the value it claims to verify" shape
 * this repo has been bitten by. It takes no I/O and no clock of its own, so the
 * real one is as cheap as a fake.
 */
export function stubBlackboard(sessions: SessionSummary[] = STUB_SESSIONS): Blackboard {
  return new Blackboard({ sessions: () => ({ ok: true, value: sessions }) });
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
    // #800. Echoes the LEVEL as well as the ref, for the reason `lastN` is
    // echoed above: this is the argument the host could silently drop or
    // silently default, and a constant here would absorb either.
    //
    // `coverage: 'whole'` and `empty: false` are the dull, succeeding defaults
    // this file exists to provide — a stub that claimed a partial read would
    // make every test that forgot to say otherwise assert against a caveat it
    // never asked for.
    sessionContextFor: (ref, level) => ({
      ok: true,
      value: {
        session: subjectOf(ref),
        coverage: 'whole',
        level: level === undefined ? 'package' : (level as 'state' | 'package' | 'excerpt'),
        // The level is echoed with `JSON.stringify` for a non-string rather than
      // `String()`: it is whatever JSON a model wrote, and an object stringifies
      // to `[object Object]` — useless in exactly the case a test is most likely
      // to be asserting about.
      text:
        `context for ${String(ref)}` +
        (level === undefined
          ? ''
          : ` level=${typeof level === 'string' ? level : JSON.stringify(level)}`),
        tokens: 42,
        empty: false,
      },
    }),
    ...over,
  };
}
