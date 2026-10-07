// The "ask it to write the handoff" switch (#1126): who a draft names, and
// what is said once the send has gone.
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../../shared/sessions';
import {
  beginHandoffWait,
  cancelHandoffWait,
  endHandoffWait,
  handoffNotice,
  handoffWaitOf,
  handoffWasCancelled,
  namedOtherSessions,
  resetHandoffWaitsForTests,
  subscribeHandoffWaits,
} from './handoff-switch';

const session = (id: string, name: string): SessionSummary =>
  ({ id, name, folder: `/p/${name}`, status: 'done', exited: false }) as unknown as SessionSummary;

const SESSIONS = [session('me', 'Web'), session('a', 'Api'), session('b', 'Trading App')];

describe('namedOtherSessions', () => {
  it('finds another session named in the draft', () => {
    expect(namedOtherSessions('look at what @Api did', SESSIONS, 'me')).toEqual(['Api']);
  });

  it('offers nobody when the draft names no session', () => {
    expect(namedOtherSessions('email me @ noon', SESSIONS, 'me')).toEqual([]);
    expect(namedOtherSessions('ping @nobody', SESSIONS, 'me')).toEqual([]);
    expect(namedOtherSessions('', SESSIONS, 'me')).toEqual([]);
  });

  it('never offers to ask THIS session — it is left as typed at send, too', () => {
    expect(namedOtherSessions('as @Web said', SESSIONS, 'me')).toEqual([]);
  });

  it('names each session once, in the order they are first mentioned', () => {
    expect(namedOtherSessions('@Trading App then @Api then @Api again', SESSIONS, 'me')).toEqual([
      'Trading App',
      'Api',
    ]);
  });

  it('finds a session named by its id, and calls it by its name', () => {
    expect(namedOtherSessions('see @a', SESSIONS, 'me')).toEqual(['Api']);
  });

  it('names nobody in a slash command — its arguments are not resolved at send either', () => {
    expect(namedOtherSessions('/review @Api', SESSIONS, 'me')).toEqual([]);
  });
});

describe('handoffNotice', () => {
  // the key and its values, so the test reads what was asked for rather than English
  const t = (key: string, values?: Record<string, unknown>): string => `${key}(${String(values?.name)})`;

  it('says nothing when nothing was asked', () => {
    expect(handoffNotice(t, undefined)).toBeNull();
    expect(handoffNotice(t, [])).toBeNull();
  });

  it('says whose handoff went', () => {
    expect(handoffNotice(t, [{ name: 'Api', outcome: 'written' }])).toBe('feedView.handoff.written(Api)');
  });

  it('says why a session did not write one, per reason', () => {
    for (const outcome of ['busy', 'waiting', 'timeout', 'asked', 'empty'] as const) {
      expect(handoffNotice(t, [{ name: 'Api', outcome }])).toBe(`feedView.handoff.${outcome}(Api)`);
    }
  });

  it('gives the three "nobody there to ask" reasons one sentence', () => {
    for (const outcome of ['not-running', 'unreachable', 'ended'] as const) {
      expect(handoffNotice(t, [{ name: 'Api', outcome }])).toBe('feedView.handoff.gone(Api)');
    }
  });

  it('gives one sentence per session, in order', () => {
    expect(
      handoffNotice(t, [
        { name: 'Api', outcome: 'written' },
        { name: 'Web', outcome: 'busy' },
      ])
    ).toBe('feedView.handoff.written(Api) feedView.handoff.busy(Web)');
  });
});

describe('the wait, kept per card', () => {
  it('remembers who the SEND was waiting on and the id it asked under', () => {
    resetHandoffWaitsForTests();
    const wait = beginHandoffWait('card-1', 'live-1', ['Api']);
    expect(handoffWaitOf('card-1')).toBe(wait);
    expect(wait.names).toEqual(['Api']);
    expect(wait.sessionId).toBe('live-1');
    expect(handoffWaitOf('card-2')).toBeUndefined();
  });

  it('hands back the SAME object until it ends — a store snapshot must not change by itself', () => {
    resetHandoffWaitsForTests();
    beginHandoffWait('card-1', 'live-1', ['Api']);
    expect(handoffWaitOf('card-1')).toBe(handoffWaitOf('card-1'));
  });

  it('tells its subscribers when a wait begins and ends, and not when one is merely cancelled', () => {
    resetHandoffWaitsForTests();
    let told = 0;
    const off = subscribeHandoffWaits(() => {
      told += 1;
    });
    const wait = beginHandoffWait('card-1', 'live-1', ['Api']);
    expect(told).toBe(1);
    cancelHandoffWait('card-1');
    expect(told).toBe(1); // the line stays up until main has answered
    endHandoffWait('card-1', wait);
    expect(told).toBe(2);
    off();
  });

  it('Cancel marks the wait and returns it, so main is told under the id it was made with', () => {
    resetHandoffWaitsForTests();
    const wait = beginHandoffWait('card-1', 'live-OLD', ['Api']);
    expect(cancelHandoffWait('card-1')).toBe(wait);
    expect(wait.cancelled).toBe(true);
    expect(wait.sessionId).toBe('live-OLD');
    expect(cancelHandoffWait('card-9')).toBeUndefined();
  });

  it('ending an OLD wait does not end a newer one for the same card', () => {
    resetHandoffWaitsForTests();
    const old = beginHandoffWait('card-1', 'live-1', ['Api']);
    const newer = beginHandoffWait('card-1', 'live-1', ['Web']);
    endHandoffWait('card-1', old);
    expect(handoffWaitOf('card-1')).toBe(newer);
  });
});

describe('handoffWasCancelled', () => {
  it('is true when the button here was pressed', () => {
    resetHandoffWaitsForTests();
    const wait = beginHandoffWait('card-1', 'live-1', ['Api']);
    cancelHandoffWait('card-1');
    expect(handoffWasCancelled(wait, [{ name: 'Api', outcome: 'written' }])).toBe(true);
  });

  it('is true when MAIN says so, even if this composer never saw the click', () => {
    expect(handoffWasCancelled(undefined, [{ name: 'Api', outcome: 'cancelled' }])).toBe(true);
  });

  it('is false for an ordinary send, with or without handoffs', () => {
    expect(handoffWasCancelled(undefined, undefined)).toBe(false);
    expect(handoffWasCancelled(undefined, [{ name: 'Api', outcome: 'busy' }])).toBe(false);
  });
});

describe('handoffNotice and a cancelled entry', () => {
  it('has no sentence for it — a cancelled send does not go, and the composer says that', () => {
    const t = (key: string): string => key;
    expect(handoffNotice(t, [{ name: 'Api', outcome: 'cancelled' }])).toBeNull();
  });
});
