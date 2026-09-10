// `send_to_session`'s delivery policy (P2-E11-05, §5.4).
//
// THE SAFETY PROPERTY IS ASSERTED BY COUNTING CALLS TO `submit`, never by
// inspecting what arrived. The done-when says why: "a test that only checks the
// text arrived would pass on a version that auto-sends". Every test below that
// is about holding a message also asserts `submit` was not reached.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AUTO_ACCEPT_LIMIT,
  AUTO_ACCEPT_WINDOW_MS,
  DELIVERY_ACK_TIMEOUT_MS,
  SiblingDelivery,
  type DeliveryDeps,
  type DeliveryReceipt,
} from './delivery';
import { SessionQueries, type SessionSummary } from './queries';
import { ANSWER_DEADLINE_MS } from '../bus/host-channel';
import { SLOW_TOOL_TIMEOUT_MS } from '../bus/bus-tools';
import {
  SIBLING_MESSAGE_CHAR_CAP,
  type SiblingAck,
  type SiblingMessage,
} from '../../shared/sibling-message';
import type { Logger } from '../log/logger';

function fakeLog(): Logger {
  const l: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: (): Logger => l };
  return l;
}

const S = (over: Partial<SessionSummary> & { id: string; name: string }): SessionSummary => ({
  folder: `/p/${over.name.toLowerCase()}`,
  providerId: 'claude-code',
  status: 'idle',
  exited: false,
  ...over,
});

const ALPHA = S({ id: 'live-a', name: 'Alpha', status: 'working' });
const BETA = S({ id: 'live-b', name: 'Beta' });

/**
 * A delivery wired to a REAL `SessionQueries.resolve` — the same resolver the
 * read tools use — over an in-memory session list, plus a window and a manager
 * that record what reaches them.
 *
 * The window answers on a LATER TICK by default, because that is what IPC
 * does; `ack: 'sync'` exists to pin the one ordering the real transport cannot
 * produce but the module claims to handle.
 */
function harness(
  opts: {
    sessions?: SessionSummary[];
    accepts?: string[];
    /** what `submit` answers; false = a Terminal-mode session */
    submits?: boolean;
    ack?: SiblingAck | 'none' | 'sync';
    window?: boolean;
    now?: () => number;
    ackTimeoutMs?: number;
  } = {},
  /** Replace a dependency outright — for the throwing and odd-answer cases. */
  override: Partial<DeliveryDeps> = {}
) {
  const sessions = opts.sessions ?? [ALPHA, BETA];
  const submitted: { liveId: string; text: string }[] = [];
  const pushed: SiblingMessage[] = [];
  const queries = new SessionQueries({ list: () => sessions, transcriptFor: () => null, git: { diff: vi.fn() } });
  const log = fakeLog();
  const deps: DeliveryDeps = {
    resolve: (ref) => queries.resolve(ref),
    cardIdFor: (liveId) => (sessions.some((s) => s.id === liveId) ? `card-${liveId}` : null),
    acceptsSiblings: (cardId) => (opts.accepts ?? []).includes(cardId),
    submit: (liveId, text) => {
      submitted.push({ liveId, text });
      return opts.submits ?? true;
    },
    push: (m) => {
      if (opts.window === false) return false;
      pushed.push(m);
      const ack = opts.ack ?? { placed: true, shown: true };
      if (ack === 'none') return true;
      if (ack === 'sync') {
        delivery.ack(m.deliveryId, { placed: true, shown: true });
        return true;
      }
      setImmediate(() => delivery.ack(m.deliveryId, ack));
      return true;
    },
    log,
    // Generous: the window acks on the next macrotask, and under a full
    // parallel suite that can take far longer than it ever does alone. A test
    // ABOUT the timeout passes its own short value.
    ackTimeoutMs: 'ackTimeoutMs' in opts ? opts.ackTimeoutMs : 5_000,
    now: opts.now,
    ...override,
  };
  const delivery = new SiblingDelivery(deps);
  return { delivery, submitted, pushed, log };
}

function value(r: Awaited<ReturnType<SiblingDelivery['send']>>): DeliveryReceipt {
  if (!r.ok) throw new Error(`expected ok, got refusal: ${r.reason}`);
  return r.value;
}

function reason(r: Awaited<ReturnType<SiblingDelivery['send']>>): string {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.value)}`);
  return r.reason;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('THE SAFETY PROPERTY — a sibling message never submits by default', () => {
  it('holds the message in the target composer and does NOT submit it', async () => {
    const h = harness();
    const r = value(await h.delivery.send('live-a', 'Beta', 'please re-run the tests'));
    expect(r.outcome).toBe('held');
    // The assertion that matters. Counting calls, not reading text.
    expect(h.submitted).toEqual([]);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toMatchObject({
      cardId: 'card-live-b',
      from: { id: 'live-a', name: 'Alpha' },
      text: 'please re-run the tests',
    });
  });

  it('the push payload has NO field that could mean "send it" — its key set is pinned', async () => {
    // `shared/sibling-message.ts` keeps the rule by SHAPE: the window cannot be
    // told to submit because there is no way to say so. Adding a field here is
    // a red test and a conversation, not a quiet convenience.
    const h = harness();
    await h.delivery.send('live-a', 'Beta', 'hi');
    expect(Object.keys(h.pushed[0]).sort()).toEqual(['at', 'cardId', 'deliveryId', 'from', 'text']);
  });

  it('an auto-accept preference that THROWS reads as off — fail-safe, not fail-open', async () => {
    const h = harness(
      {},
      {
        acceptsSiblings: () => {
          throw new Error('store unreadable');
        },
      }
    );
    const r = value(await h.delivery.send('live-a', 'Beta', 'hi'));
    expect(r.outcome).toBe('held');
    expect(h.submitted).toEqual([]);
  });

  it('a preference that answers something truthy but not `true` is off', async () => {
    const h = harness({}, { acceptsSiblings: () => 'yes' as unknown as boolean });
    expect(value(await h.delivery.send('live-a', 'Beta', 'hi')).outcome).toBe('held');
    expect(h.submitted).toEqual([]);
  });
});

describe('with auto-accept on', () => {
  it('submits, with a header saying nobody reviewed it, and does not push to the window', async () => {
    const h = harness({ accepts: ['card-live-b'] });
    const r = value(await h.delivery.send('live-a', 'Beta', 'step 2'));
    expect(r.outcome).toBe('submitted');
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].liveId).toBe('live-b');
    expect(h.submitted[0].text).toContain('step 2');
    expect(h.submitted[0].text).toContain('"Alpha" (session id live-a)');
    expect(h.submitted[0].text).toMatch(/delivered automatically/);
    expect(h.pushed).toEqual([]);
  });

  it('is per CARD — another card with it on does not open this one', async () => {
    const h = harness({ accepts: ['card-live-a'] });
    expect(value(await h.delivery.send('live-a', 'Beta', 'x')).outcome).toBe('held');
    expect(h.submitted).toEqual([]);
  });

  it('a Terminal-mode session (submit answers false) is HELD, not dropped, and says why', async () => {
    const h = harness({ accepts: ['card-live-b'], submits: false });
    const r = value(await h.delivery.send('live-a', 'Beta', 'x'));
    expect(r).toMatchObject({ outcome: 'held', held: 'terminal' });
    expect(h.pushed).toHaveLength(1);
  });

  it('a submit that THROWS is held too — a bug of ours never drops the message', async () => {
    const h = harness(
      { accepts: ['card-live-b'] },
      {
        submit: () => {
          throw new Error('stdin closed');
        },
      }
    );
    expect(value(await h.delivery.send('live-a', 'Beta', 'x')).outcome).toBe('held');
    expect(h.pushed).toHaveLength(1);
  });

  it.each(['needs-input', 'needs-permission', 'starting'] as const)(
    'a target that is %s is HELD — a sibling message is not the answer to its question',
    async (status) => {
      const h = harness({ accepts: ['card-live-b'], sessions: [ALPHA, S({ id: 'live-b', name: 'Beta', status })] });
      const r = value(await h.delivery.send('live-a', 'Beta', 'x'));
      expect(r).toMatchObject({ outcome: 'held', held: 'not-ready' });
      expect(h.submitted).toEqual([]);
    }
  );

  it.each(['idle', 'done', 'working'] as const)('a target that is %s may be submitted to', async (status) => {
    const h = harness({ accepts: ['card-live-b'], sessions: [ALPHA, S({ id: 'live-b', name: 'Beta', status })] });
    expect(value(await h.delivery.send('live-a', 'Beta', 'x')).outcome).toBe('submitted');
  });
});

describe('the loop breaker', () => {
  it(`takes at most ${AUTO_ACCEPT_LIMIT} automatic sends per window, then HOLDS and says why`, async () => {
    let t = 1_000_000;
    const h = harness({ accepts: ['card-live-b'], now: () => t });
    for (let i = 0; i < AUTO_ACCEPT_LIMIT; i++) {
      expect(value(await h.delivery.send('live-a', 'Beta', `m${i}`)).outcome).toBe('submitted');
      t += 1_000;
    }
    const over = value(await h.delivery.send('live-a', 'Beta', 'one too many'));
    expect(over).toMatchObject({
      outcome: 'held',
      held: 'limit',
      limit: { count: AUTO_ACCEPT_LIMIT, minutes: AUTO_ACCEPT_WINDOW_MS / 60_000 },
    });
    expect(h.submitted).toHaveLength(AUTO_ACCEPT_LIMIT);
    expect(h.pushed.map((m) => m.text)).toEqual(['one too many']);
  });

  it('forgets sends older than the window — a slow pipeline is never throttled', async () => {
    let t = 0;
    const h = harness({ accepts: ['card-live-b'], now: () => t });
    for (let i = 0; i < AUTO_ACCEPT_LIMIT * 3; i++) {
      expect(value(await h.delivery.send('live-a', 'Beta', `step ${i}`)).outcome).toBe('submitted');
      t += AUTO_ACCEPT_WINDOW_MS / AUTO_ACCEPT_LIMIT + 1;
    }
    expect(h.submitted).toHaveLength(AUTO_ACCEPT_LIMIT * 3);
  });

  it('is counted per TARGET — one busy pipeline does not throttle another', async () => {
    const gamma = S({ id: 'live-c', name: 'Gamma' });
    const h = harness({ accepts: ['card-live-b', 'card-live-c'], sessions: [ALPHA, BETA, gamma], now: () => 5 });
    for (let i = 0; i < AUTO_ACCEPT_LIMIT; i++) await h.delivery.send('live-a', 'Beta', `b${i}`);
    expect(value(await h.delivery.send('live-a', 'Gamma', 'g')).outcome).toBe('submitted');
  });

  it('a HELD message does not count against the limit', async () => {
    const h = harness({ accepts: ['card-live-b'], submits: false, now: () => 5 });
    for (let i = 0; i < AUTO_ACCEPT_LIMIT + 2; i++) {
      expect(value(await h.delivery.send('live-a', 'Beta', `m${i}`))).toMatchObject({ held: 'terminal' });
    }
  });
});

describe('LOOP SAFETY, EXERCISED — two sessions each told to reply to the other', () => {
  /**
   * Two simulated agents that answer EVERY message they receive by sending one
   * back — the worst case, with no judgement to stop them. "Receive" means the
   * message was SUBMITTED to that session: a message held in a composer has not
   * reached the agent, and it cannot answer what it has not been given.
   *
   * The replies run on a macrotask, as a real agent's next turn would, and the
   * loop is driven until it goes quiet or a hard ceiling far above any correct
   * answer — so a regression shows up as a number, not as a hung test.
   */
  async function runPingPong(accepts: string[]): Promise<{ sends: number; submits: number; held: number }> {
    const sessions = [ALPHA, BETA];
    const queries = new SessionQueries({ list: () => sessions, transcriptFor: () => null, git: { diff: vi.fn() } });
    let sends = 0;
    let submits = 0;
    let held = 0;
    const inFlight: Promise<unknown>[] = [];
    const replyFrom = (liveId: string): void => {
      const other = liveId === 'live-a' ? 'Beta' : 'Alpha';
      inFlight.push(
        new Promise((resolve) => setImmediate(resolve)).then(() => send(liveId, other, 'reply to your last message'))
      );
    };
    const delivery: SiblingDelivery = new SiblingDelivery({
      resolve: (ref) => queries.resolve(ref),
      cardIdFor: (id) => `card-${id}`,
      acceptsSiblings: (cardId) => accepts.includes(cardId),
      submit: (liveId) => {
        submits++;
        replyFrom(liveId); // the recipient's agent answers at once
        return true;
      },
      push: (m) => {
        held++;
        setImmediate(() => delivery.ack(m.deliveryId, { placed: true, shown: true }));
        return true;
      },
      log: fakeLog(),
      ackTimeoutMs: 200,
      now: () => 1_000, // a loop runs fast — the whole thing inside one window
    });
    const send = async (from: string, to: string, text: string): Promise<void> => {
      sends++;
      if (sends > 500) throw new Error('RUNAWAY: the loop did not stop');
      await delivery.send(from, to, text);
    };
    // Alpha opens the conversation, as if the user had told it to talk to Beta.
    await send('live-a', 'Beta', 'hello — please reply');
    while (inFlight.length > 0) await inFlight.shift();
    return { sends, submits, held };
  }

  it('WITH DEFAULTS: one message, held, and it stops there', async () => {
    const r = await runPingPong([]);
    expect(r).toEqual({ sends: 1, submits: 0, held: 1 });
  });

  it('with auto-accept on ONE side only: one hop in, one hop back held, then quiet', async () => {
    const r = await runPingPong(['card-live-b']);
    // Alpha → Beta is submitted, Beta answers, Beta → Alpha is HELD because
    // Alpha takes nothing automatically. Two sends and the loop is over.
    expect(r).toEqual({ sends: 2, submits: 1, held: 1 });
  });

  it('with auto-accept on BOTH sides — the loop §5.4 warns about — the breaker bounds it', async () => {
    const r = await runPingPong(['card-live-a', 'card-live-b']);
    // Each side takes AUTO_ACCEPT_LIMIT automatically, then the next message to
    // it waits for a person and nothing answers it. Bounded, and by a number
    // anyone can read off the constants.
    expect(r.submits).toBe(AUTO_ACCEPT_LIMIT * 2);
    expect(r.held).toBe(1);
    expect(r.sends).toBe(AUTO_ACCEPT_LIMIT * 2 + 1);
  });
});

describe('refusals — each one says the message did not go, and why', () => {
  it.each([
    ['not text', 42, /must be text/],
    ['empty', '   \n ', /empty/],
    ['over the cap', 'x'.repeat(SIBLING_MESSAGE_CHAR_CAP + 1), /limit is 20,000/],
  ])('a message that is %s', async (_label, message, re) => {
    const h = harness();
    expect(reason(await h.delivery.send('live-a', 'Beta', message))).toMatch(re);
    expect(h.pushed).toEqual([]);
    expect(h.submitted).toEqual([]);
  });

  it('a message carrying a TERMINAL ESCAPE is refused — the user’s one Enter must not become keystrokes (#765 review)', async () => {
    const ESC = String.fromCharCode(27);
    const h = harness({ accepts: ['card-live-b'] });
    expect(reason(await h.delivery.send('live-a', 'Beta', `looks fine ${ESC}[201~\rsurprise`))).toMatch(
      /control characters.*plain text/
    );
    expect(h.pushed).toEqual([]);
    expect(h.submitted).toEqual([]);
  });

  it('a bidi override is refused too — it makes the reviewed text differ from the sent text', async () => {
    const h = harness();
    expect(reason(await h.delivery.send('live-a', 'Beta', `ok ${String.fromCharCode(0x202e)}desrever`))).toMatch(
      /control characters/
    );
  });

  it('Windows line endings are NOT refused — they are normalised, and the window gets \\n', async () => {
    const h = harness();
    expect(value(await h.delivery.send('live-a', 'Beta', 'line one\r\nline two')).outcome).toBe('held');
    expect(h.pushed[0].text).toBe('line one\nline two');
  });

  it('a message exactly AT the cap is accepted — the boundary is inclusive', async () => {
    const h = harness();
    expect(value(await h.delivery.send('live-a', 'Beta', 'x'.repeat(SIBLING_MESSAGE_CHAR_CAP))).outcome).toBe('held');
  });

  it('an unknown session refuses with the sessions that DO exist (the resolver is the read tools’ own)', async () => {
    const h = harness();
    expect(reason(await h.delivery.send('live-a', 'Nobody', 'x'))).toMatch(/no session named "Nobody".*Alpha, Beta/);
  });

  it('an ambiguous name refuses rather than guessing a recipient', async () => {
    const h = harness({ sessions: [ALPHA, BETA, S({ id: 'live-b2', name: 'Beta' })] });
    expect(reason(await h.delivery.send('live-a', 'Beta', 'x'))).toMatch(/ambiguous/);
    expect(h.pushed).toEqual([]);
  });

  it('sending to yourself is refused — by id and by name', async () => {
    const h = harness();
    expect(reason(await h.delivery.send('live-a', 'live-a', 'x'))).toMatch(/cannot send a message to itself/);
    expect(reason(await h.delivery.send('live-a', 'Alpha', 'x'))).toMatch(/cannot send a message to itself/);
    expect(h.pushed).toEqual([]);
  });

  it('an EXITED session is refused — including a clean exit whose status reads "done"', async () => {
    // The case the handoff warned about: `list()` keeps an exited session until
    // the reap, and a clean exit is `status: 'done'` — the same word as a
    // finished turn. Membership says yes; status says "done"; only `exited`
    // tells the truth.
    const gone = S({ id: 'live-b', name: 'Beta', status: 'done', exited: true });
    const h = harness({ sessions: [ALPHA, gone], accepts: ['card-live-b'] });
    expect(reason(await h.delivery.send('live-a', 'Beta', 'x'))).toMatch(/has exited/);
    expect(h.pushed).toEqual([]);
    expect(h.submitted).toEqual([]);
  });

  it('a session that finished its TURN (done, not exited) is delivered to', async () => {
    const h = harness({ sessions: [ALPHA, S({ id: 'live-b', name: 'Beta', status: 'done' })] });
    expect(value(await h.delivery.send('live-a', 'Beta', 'x')).outcome).toBe('held');
  });

  it('a crashed session is refused even if the flag somehow disagrees', async () => {
    const h = harness({ sessions: [ALPHA, S({ id: 'live-b', name: 'Beta', status: 'crashed' })] });
    expect(reason(await h.delivery.send('live-a', 'Beta', 'x'))).toMatch(/has exited/);
  });

  it('the sender is named by ID ONLY — a caller missing from the list is never credited with a namesake’s title', async () => {
    // `resolve` falls back to matching by name. A caller whose live id is
    // absent from the list (exiting, say) but equals some card's TITLE would
    // otherwise sign the message with that card's name.
    const impostor = S({ id: 'live-z', name: 'live-gone' });
    const h = harness({ sessions: [impostor, BETA] });
    await h.delivery.send('live-gone', 'Beta', 'x');
    expect(h.pushed[0].from).toEqual({ id: 'live-gone', name: '(unknown session)' });
  });

  it('the sender’s name is CLEANED before the push — the window’s own check would otherwise refuse it every time (round 2)', async () => {
    // The renderer answers no ack for a name carrying an invisible character.
    // A card titled with a direction mark in it would then make every message
    // this session sends end as "unconfirmed", for no visible reason.
    const odd = S({ id: 'live-a', name: `Alp${String.fromCharCode(0x200f)}ha` });
    const h = harness({ sessions: [odd, BETA] });
    await h.delivery.send('live-a', 'Beta', 'x');
    expect(h.pushed[0].from).toEqual({ id: 'live-a', name: 'Alpha' });
  });

  it('a live session with no card is refused, not guessed', async () => {
    const h = harness({}, { cardIdFor: () => null });
    expect(reason(await h.delivery.send('live-a', 'Beta', 'x'))).toMatch(/no message box/);
  });
});

describe('never silently dropped — "delivered" and "went nowhere" are always told apart', () => {
  it('NO WINDOW is an explicit refusal, immediately', async () => {
    const h = harness({ window: false });
    const t0 = Date.now();
    expect(reason(await h.delivery.send('live-a', 'Beta', 'x'))).toMatch(/no switchboard window is open/);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('a push that THROWS is the same refusal, not a hang', async () => {
    const h = harness(
      {},
      {
        push: () => {
          throw new Error('webContents gone');
        },
      }
    );
    expect(reason(await h.delivery.send('live-a', 'Beta', 'x'))).toMatch(/no switchboard window/);
  });

  it('a window that never answers is UNCONFIRMED — hedged, never "not delivered"', async () => {
    const h = harness({ ack: 'none', ackTimeoutMs: 30 });
    const r = value(await h.delivery.send('live-a', 'Beta', 'x'));
    expect(r.outcome).toBe('unconfirmed');
    expect(h.submitted).toEqual([]);
  });

  it('a FULL inbox is a refusal the sender can act on', async () => {
    const h = harness({ ack: { placed: false, reason: 'full' } });
    expect(reason(await h.delivery.send('live-a', 'Beta', 'x'))).toMatch(/cannot hold more/);
  });

  it('reports whether the target composer is on screen', async () => {
    const h = harness({ ack: { placed: true, shown: false } });
    expect(value(await h.delivery.send('live-a', 'Beta', 'x'))).toMatchObject({ outcome: 'held', shown: false });
  });

  it('a window that answers in the SAME TICK is still heard (registered before the push)', async () => {
    const h = harness({ ack: 'sync' });
    expect(value(await h.delivery.send('live-a', 'Beta', 'x'))).toMatchObject({ outcome: 'held', shown: true });
  });

  it('a malformed ack is NOT read as a placement', async () => {
    const h = harness({ ack: { placed: 'yes' } as unknown as SiblingAck });
    expect(value(await h.delivery.send('live-a', 'Beta', 'x')).outcome).toBe('unconfirmed');
  });

  it('a late or unknown ack is ignored and says so', () => {
    const h = harness();
    expect(h.delivery.ack('never-sent', { placed: true, shown: true })).toBe(false);
    expect(h.delivery.ack(42, { placed: true, shown: true })).toBe(false);
  });

  it('two sends in flight get their OWN acks', async () => {
    const h = harness({ ack: 'none', ackTimeoutMs: 500 });
    const one = h.delivery.send('live-a', 'Beta', 'first');
    const two = h.delivery.send('live-a', 'Beta', 'second');
    await new Promise((r) => setImmediate(r));
    const [m1, m2] = h.pushed;
    h.delivery.ack(m2.deliveryId, { placed: true, shown: false });
    h.delivery.ack(m1.deliveryId, { placed: true, shown: true });
    expect(value(await one)).toMatchObject({ shown: true });
    expect(value(await two)).toMatchObject({ shown: false });
  });
});

describe('the cascade — the innermost deadline fires first', () => {
  it('ack timeout < host answer deadline < the child’s slow-tool timeout', () => {
    // If the host's own deadline fired first, the agent would be told
    // "switchboard took too long and gave up" — a flat claim that nothing
    // happened, about a message the window may be showing. See the constant.
    expect(DELIVERY_ACK_TIMEOUT_MS).toBeLessThan(ANSWER_DEADLINE_MS);
    expect(ANSWER_DEADLINE_MS).toBeLessThan(SLOW_TOOL_TIMEOUT_MS);
  });

  it('really uses DELIVERY_ACK_TIMEOUT_MS when no seam is passed', async () => {
    vi.useFakeTimers();
    const h = harness({ ack: 'none', ackTimeoutMs: undefined });
    let settled = false;
    const p = h.delivery.send('live-a', 'Beta', 'x').then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(DELIVERY_ACK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(value(await p).outcome).toBe('unconfirmed');
  });
});
