// The deciding half (P2-E14-06): when a `push` / `webhook` action fires, what
// it reads, and what it does when the answer is "nothing is set up" or "the
// phone is off".
//
// Three properties are graded here and none of them are cosmetic:
//   1. an unconfigured app sends nothing and says nothing;
//   2. a delivery failure is fail-open and logged ONCE, not once per event;
//   3. no credential reaches a log line, on any path.
import { describe, it, expect, vi } from 'vitest';
import { PushActions, SecretReader } from './push-actions';
import { PushPrefs, PushSecretKey } from '../../shared/push';
import { LogFields, Logger } from '../log/logger';
import type { RuleActionContext } from './rules-engine';

const TOPIC = 'topic-9f3a-SECRET';
const HOOK = 'https://hooks.example.test/secret-path';

interface LogLine {
  level: string;
  msg: string;
  fields?: LogFields;
}

function harness(
  over: {
    prefs?: Partial<PushPrefs>;
    stored?: Partial<Record<PushSecretKey, string>>;
    available?: boolean;
    response?: { ok?: boolean; status?: number; body?: string };
    throws?: boolean;
  } = {}
) {
  const logs: LogLine[] = [];
  const rec =
    (level: string) =>
    (msg: string, fields?: LogFields): void => void logs.push({ level, msg, fields });
  const log = {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child: () => log,
  } as unknown as Logger;

  const stored = over.stored ?? {};
  const secrets: SecretReader = {
    available: () => over.available !== false,
    get: (k) => stored[k] ?? null,
  };
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: unknown) => {
    calls.push(String(url));
    if (over.throws) throw new Error('ENOTFOUND');
    return {
      ok: over.response?.ok ?? true,
      status: over.response?.status ?? 200,
      text: async () => over.response?.body ?? '{"status":1}',
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const actions = new PushActions({
    secrets,
    getPrefs: () => ({ push: false, service: 'ntfy', webhook: false, ...over.prefs }),
    log,
    fetchImpl,
  });
  return {
    actions,
    logs,
    calls,
    text: () => JSON.stringify(logs),
    warnings: () => logs.filter((l) => l.level === 'warn'),
  };
}

/** A logger that keeps what it was told — for the cases that need their own. */
function recordingLog(): { log: Logger; logs: LogLine[] } {
  const logs: LogLine[] = [];
  const rec =
    (level: string) =>
    (msg: string, fields?: LogFields): void => void logs.push({ level, msg, fields });
  const log = {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child: () => log,
  } as unknown as Logger;
  return { log, logs };
}

function ctx(over: Partial<RuleActionContext> = {}): RuleActionContext {
  return {
    event: { id: 1, sessionId: 'live-1', kind: 'needs-permission', at: '2026-08-13T10:00:00.000Z' },
    cardId: 'card-a',
    visibility: 'hidden',
    rule: { id: 'default:push:needs-permission', event: 'needs-permission', actions: [] },
    title: 'TradingApp',
    body: 'needs permission',
    ...over,
  };
}

describe('an app with nothing configured', () => {
  it('sends nothing when the switch is off, even with a topic stored', async () => {
    const h = harness({ stored: { 'ntfy.topic': TOPIC } });
    await h.actions.pushHandler({ type: 'push' }, ctx());
    expect(h.calls).toEqual([]);
  });

  it('sends nothing when the switch is on but no credential was pasted', async () => {
    const h = harness({ prefs: { push: true, webhook: true } });
    await h.actions.pushHandler({ type: 'push' }, ctx());
    await h.actions.webhookHandler({ type: 'webhook' }, ctx());
    expect(h.calls).toEqual([]);
  });

  // The resting state of a feature nobody turned on must not write a line per
  // attention event — that is how a log stops being readable.
  it('says nothing in the log about being unconfigured', async () => {
    const h = harness({ prefs: { push: true } });
    for (let i = 0; i < 5; i++) await h.actions.pushHandler({ type: 'push' }, ctx());
    expect(h.logs).toEqual([]);
  });

  it('reports no-store when the machine has no credential store', async () => {
    const h = harness({ prefs: { push: true }, available: false, stored: { 'ntfy.topic': TOPIC } });
    expect(await h.actions.sendPush({ title: 'a', message: 'b', kind: 'done' })).toEqual({
      ok: false,
      reason: 'no-store',
    });
    expect(h.calls).toEqual([]);
  });
});

describe('a configured push', () => {
  it('sends, and logs what fired without the credential in it', async () => {
    const h = harness({ prefs: { push: true }, stored: { 'ntfy.topic': TOPIC } });
    await h.actions.pushHandler({ type: 'push' }, ctx());
    expect(h.calls).toEqual(['https://ntfy.sh/']);
    expect(h.logs.map((l) => l.msg)).toEqual(['an outbound notification was sent']);
    expect(h.text()).not.toContain(TOPIC);
    expect(h.logs[0].fields).toMatchObject({ channel: 'push', kind: 'needs-permission' });
  });

  it('uses Pushover when that is the picked service', async () => {
    const h = harness({
      prefs: { push: true, service: 'pushover' },
      stored: { 'pushover.token': 'app-token', 'pushover.user': 'user-key' },
    });
    await h.actions.pushHandler({ type: 'push' }, ctx());
    expect(h.calls[0]).toContain('api.pushover.net');
  });

  it('needs both Pushover keys, and sends nothing with only one', async () => {
    const h = harness({
      prefs: { push: true, service: 'pushover' },
      stored: { 'pushover.token': 'app-token' },
    });
    await h.actions.pushHandler({ type: 'push' }, ctx());
    expect(h.calls).toEqual([]);
  });

  it('POSTs the webhook to the stored URL', async () => {
    const h = harness({ prefs: { webhook: true }, stored: { 'webhook.url': HOOK } });
    await h.actions.webhookHandler({ type: 'webhook' }, ctx());
    expect(h.calls).toEqual([HOOK]);
  });

  // Fail-open (P6): the handler is dispatched, not awaited, by the engine — so
  // the one thing it must never do is reject.
  it('never rejects, whatever the network does', async () => {
    const h = harness({ prefs: { push: true }, stored: { 'ntfy.topic': TOPIC }, throws: true });
    await expect(h.actions.pushHandler({ type: 'push' }, ctx())).resolves.toBeUndefined();
    expect(h.warnings()).toHaveLength(1);
  });
});

describe('one failure, one log line', () => {
  it('logs the first failure and COUNTS the repeats', async () => {
    const h = harness({ prefs: { push: true }, stored: { 'ntfy.topic': TOPIC }, throws: true });
    for (let i = 0; i < 4; i++) await h.actions.pushHandler({ type: 'push' }, ctx());
    expect(h.warnings()).toHaveLength(1);
    expect(h.warnings()[0].msg).toBe('an outbound notification did not get through');
    expect(h.text()).not.toContain(TOPIC);
  });

  it('the same failure repeated is still one line — a phone that is off all evening', async () => {
    const h = harness({
      prefs: { push: true },
      stored: { 'ntfy.topic': TOPIC },
      response: { ok: false, status: 500, body: 'boom' },
    });
    await h.actions.pushHandler({ type: 'push' }, ctx());
    await h.actions.pushHandler({ type: 'push' }, ctx());
    expect(h.warnings()).toHaveLength(1);
  });

  // The regression the first version of this could not catch: Pushover puts a
  // fresh request id in EVERY response body, and most webhook hosts put a
  // request/ray id in theirs — so a signature keyed on the response detail
  // never matched and the "one line" promise became one line per event.
  it('is still one line when the service`s body CHANGES every time', async () => {
    let n = 0;
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => `{"status":0,"request":"${n++}-3f9a-uuid","errors":["bad token"]}`,
      }) as unknown as Response) as unknown as typeof fetch;
    const seen = recordingLog();
    const actions = new PushActions({
      secrets: { available: () => true, get: () => TOPIC },
      getPrefs: () => ({ push: true, service: 'ntfy', webhook: false }),
      log: seen.log,
      fetchImpl,
    });
    for (let i = 0; i < 6; i++) await actions.pushHandler({ type: 'push' }, ctx());
    // the bodies really were all different — otherwise this passes vacuously
    expect(n).toBe(6);
    expect(seen.logs.filter((l) => l.level === 'warn')).toHaveLength(1);
  });

  // A DIFFERENT status is a different fact and gets its own line — the
  // suppression must not swallow "it started 500ing" after a 404.
  it('a different HTTP status is worth its own line', async () => {
    let status = 404;
    const fetchImpl = (async () =>
      ({ ok: false, status, text: async () => 'nope' }) as unknown as Response) as unknown as typeof fetch;
    const seen = recordingLog();
    const actions = new PushActions({
      secrets: { available: () => true, get: () => TOPIC },
      getPrefs: () => ({ push: true, service: 'ntfy', webhook: false }),
      log: seen.log,
      fetchImpl,
    });
    await actions.pushHandler({ type: 'push' }, ctx());
    await actions.pushHandler({ type: 'push' }, ctx());
    status = 500;
    await actions.pushHandler({ type: 'push' }, ctx());
    expect(seen.logs.filter((l) => l.level === 'warn')).toHaveLength(2);
  });

  // `bad-url` is NOT silent, unlike `not-configured`: it is a mistake the user
  // just made, not the resting state of a feature nobody turned on.
  it('says something when the destination itself is unusable', async () => {
    const h = harness({
      prefs: { push: true, ntfyServer: 'ntfy.example.test' },
      stored: { 'ntfy.topic': TOPIC },
    });
    await h.actions.pushHandler({ type: 'push' }, ctx());
    expect(h.calls).toEqual([]);
    expect(h.warnings()).toHaveLength(1);
    expect(h.warnings()[0].fields).toMatchObject({ reason: 'bad-url' });
  });

  it('the failure line names the channel and the reason, never the destination', async () => {
    const h = harness({
      prefs: { webhook: true },
      stored: { 'webhook.url': HOOK },
      response: { ok: false, status: 404, body: `no hook at ${HOOK}` },
    });
    await h.actions.webhookHandler({ type: 'webhook' }, ctx());
    const line = h.warnings()[0];
    expect(line.fields).toMatchObject({ channel: 'webhook', reason: 'refused' });
    expect(JSON.stringify(line)).not.toContain('secret-path');
  });
});

describe('recovery clears the counter', () => {
  it('logs a success after failures, with the count it swallowed', async () => {
    let failing = true;
    const logs: LogLine[] = [];
    const rec =
      (level: string) =>
      (msg: string, fields?: LogFields): void => void logs.push({ level, msg, fields });
    const log = {
      debug: rec('debug'),
      info: rec('info'),
      warn: rec('warn'),
      error: rec('error'),
      child: () => log,
    } as unknown as Logger;
    const fetchImpl = (async () => {
      if (failing) throw new Error('ENOTFOUND');
      return { ok: true, status: 200, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    const actions = new PushActions({
      secrets: { available: () => true, get: () => TOPIC },
      getPrefs: () => ({ push: true, service: 'ntfy', webhook: false }),
      log,
      fetchImpl,
    });
    for (let i = 0; i < 3; i++) await actions.pushHandler({ type: 'push' }, ctx());
    failing = false;
    await actions.pushHandler({ type: 'push' }, ctx());
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(1);
    const success = logs.find((l) => l.msg === 'an outbound notification was sent');
    expect(success?.fields).toMatchObject({ afterFailures: 2 });
  });
});

describe('Send test', () => {
  it('sends even with the automatic switch OFF — it is an explicit gesture', async () => {
    const h = harness({ stored: { 'ntfy.topic': TOPIC } });
    expect(await h.actions.test('push')).toEqual({ ok: true });
    expect(h.calls).toEqual(['https://ntfy.sh/']);
  });

  it('still refuses with no credential, and says why', async () => {
    const h = harness();
    expect(await h.actions.test('webhook')).toMatchObject({ reason: 'not-configured' });
  });

  it('logs the attempt (the user is watching) without the credential', async () => {
    const h = harness({ stored: { 'ntfy.topic': TOPIC } });
    await h.actions.test('push');
    expect(h.logs.map((l) => l.msg)).toContain('an outbound notification test was sent');
    expect(h.text()).not.toContain(TOPIC);
  });

  it('a webhook test POSTs the documented shape', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: unknown, init: unknown) => {
      // `RequestInit['body']` is the whole `BodyInit` union, which `String()`
      // renders as '[object Object]'. The webhook sends JSON text; recording a
      // marker instead of throwing puts a violation into the `JSON.parse`
      // failure below, where it is readable — `PushActions.test` catches, so a
      // throw here would only show up as an empty `bodies`.
      const { body } = (init ?? {}) as RequestInit;
      bodies.push(typeof body === 'string' ? body : `<non-string body: ${typeof body}>`);
      return { ok: true, status: 200, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    const actions = new PushActions({
      secrets: { available: () => true, get: () => HOOK },
      getPrefs: () => ({ push: false, service: 'ntfy', webhook: false }),
      fetchImpl,
    });
    await actions.test('webhook', new Date('2026-08-13T10:00:00.000Z'));
    expect(JSON.parse(bodies[0])).toMatchObject({
      source: 'switchboard.ai',
      event: 'done',
      at: '2026-08-13T10:00:00.000Z',
      // …and it is MARKED as a test, so a consumer wired to an automation does
      // not act on a session that never ran (review finding)
      test: true,
    });
  });
});
