// The phone-push IPC seam (P2-E14-06, §5.29).
//
// The claim under test is the SHAPE of the boundary: what the renderer can ask
// for, what it gets back, and — the one that matters — what it can never get
// back. A future refactor that adds a convenient `push:getSecret` fails here.
import { describe, it, expect, beforeEach } from 'vitest';
import { registerPushIpc } from './push-ipc';
import { PushActions } from './push-actions';
import { SecretStore } from '../secrets/store';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { WorkspaceStore } from '../workspace/store';
import { PushConfig, PushPrefs, PushSecretKey } from '../../shared/push';
import { CHANNEL_CAPABILITIES } from '../../shared/ipc/capabilities';

type Handler = (e: unknown, ...args: unknown[]) => unknown;
const TOPIC = 'topic-9f3a-SECRET';

function harness(opts: { available?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const logs: Array<{ level: string; msg: string; fields?: LogFields }> = [];
  const values = new Map<string, string>();
  let prefs: PushPrefs = { push: false, service: 'ntfy', webhook: false };

  const broker = {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as IpcBroker;
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
  const store = {
    getPushPrefs: () => ({ ...prefs }),
    setPushPrefs: (p: Partial<PushPrefs>) => {
      prefs = { ...prefs, ...p };
      return { ...prefs };
    },
  } as unknown as WorkspaceStore;
  const secrets = {
    available: () => opts.available !== false,
    has: (k: string) => values.has(k),
    get: (k: string) => values.get(k) ?? null,
    set: (k: string, v: string) => {
      if (opts.available === false) return false;
      values.set(k, v);
      return true;
    },
    clear: (k: string) => values.delete(k),
  } as unknown as SecretStore;
  const actions = new PushActions({
    secrets: { available: () => opts.available !== false, get: (k) => values.get(k) ?? null },
    getPrefs: () => ({ ...prefs }),
    log,
    fetchImpl: (async () => ({ ok: true, status: 200, text: async () => '' })) as unknown as typeof fetch,
  });

  registerPushIpc({ broker, log, store, secrets, actions });
  return {
    handlers,
    values,
    logs,
    text: () => JSON.stringify(logs),
    get prefs() {
      return prefs;
    },
    call: (channel: string, ...args: unknown[]) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`nothing registered on ${channel}`);
      return fn({}, ...args);
    },
  };
}

describe('the channels this feature exposes', () => {
  it('registers exactly four, and every one is capability-tagged', () => {
    const h = harness();
    expect([...h.handlers.keys()].sort()).toEqual([
      'push:getConfig',
      'push:setPrefs',
      'push:setSecret',
      'push:test',
    ]);
    for (const channel of h.handlers.keys())
      expect(CHANNEL_CAPABILITIES[channel as keyof typeof CHANNEL_CAPABILITIES]).toBeTruthy();
  });

  // The security property, pinned as a test rather than as a comment: there is
  // no way back across this boundary for a stored value.
  it('exposes NO channel that reads a credential back', () => {
    const h = harness();
    h.call('push:setSecret', 'ntfy.topic', TOPIC);
    for (const channel of h.handlers.keys()) expect(channel).not.toMatch(/getSecret|readSecret/i);
    const config = h.call('push:getConfig') as PushConfig;
    expect(JSON.stringify(config)).not.toContain(TOPIC);
    expect(config.secrets['ntfy.topic']).toBe(true); // "set", not the value
  });
});

describe('push:getConfig', () => {
  it('answers switches, per-slot booleans and whether the store works', () => {
    const h = harness();
    expect(h.call('push:getConfig')).toEqual({
      prefs: { push: false, service: 'ntfy', webhook: false },
      secrets: {
        'ntfy.topic': false,
        'pushover.token': false,
        'pushover.user': false,
        'webhook.url': false,
      },
      storeAvailable: true,
    });
  });

  it('reports a machine with no credential store honestly', () => {
    expect((harness({ available: false }).call('push:getConfig') as PushConfig).storeAvailable).toBe(
      false
    );
  });
});

describe('push:setPrefs', () => {
  it('merge-patches, and answers with the whole config', () => {
    const h = harness();
    const after = h.call('push:setPrefs', { push: true }) as PushConfig;
    expect(after.prefs).toMatchObject({ push: true, webhook: false, service: 'ntfy' });
    h.call('push:setPrefs', { service: 'pushover' });
    expect(h.prefs).toMatchObject({ push: true, service: 'pushover' });
  });

  it.each([
    ['a non-object patch', ['nope'], 'must be an object'],
    ['a non-boolean switch', [{ push: 'yes' }], 'push must be true or false'],
    ['an unknown service', [{ service: 'telegram' }], 'unknown push service'],
    ['a non-string server', [{ ntfyServer: 7 }], 'must be a string'],
  ])('refuses %s with the truth and a warning', (_n, args, reason) => {
    const h = harness();
    const after = h.call('push:setPrefs', ...(args as unknown[])) as PushConfig;
    expect(after.prefs.push).toBe(false);
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes(reason as string))).toBe(true);
  });

  it('logs the switches — none of them is a credential', () => {
    const h = harness();
    h.call('push:setPrefs', { push: true });
    expect(h.logs.some((l) => l.msg === 'phone-push settings changed')).toBe(true);
  });
});

describe('push:setSecret', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('stores one, and never echoes it back or logs it', () => {
    const after = h.call('push:setSecret', 'ntfy.topic', TOPIC) as PushConfig;
    expect(after.secrets['ntfy.topic']).toBe(true);
    expect(h.values.get('ntfy.topic')).toBe(TOPIC);
    expect(JSON.stringify(after)).not.toContain(TOPIC);
    expect(h.text()).not.toContain(TOPIC);
  });

  it('an empty value forgets it', () => {
    h.call('push:setSecret', 'ntfy.topic', TOPIC);
    const after = h.call('push:setSecret', 'ntfy.topic', '  ') as PushConfig;
    expect(after.secrets['ntfy.topic']).toBe(false);
    expect(h.values.has('ntfy.topic')).toBe(false);
  });

  it('refuses a slot it does not know, rather than storing an arbitrary key', () => {
    h.call('push:setSecret', 'anthropic.apiKey' as PushSecretKey, 'sk-nope');
    expect(h.values.size).toBe(0);
    expect(h.logs.some((l) => l.msg.includes('unknown credential slot'))).toBe(true);
  });

  it('refuses a non-string value', () => {
    h.call('push:setSecret', 'ntfy.topic', { toString: () => TOPIC });
    expect(h.values.size).toBe(0);
  });

  it('tells the truth when the store refused it', () => {
    const none = harness({ available: false });
    const after = none.call('push:setSecret', 'ntfy.topic', TOPIC) as PushConfig;
    expect(after.secrets['ntfy.topic']).toBe(false);
    expect(none.logs.some((l) => l.msg.includes('could not be stored'))).toBe(true);
  });
});

describe('push:test', () => {
  it('sends on a known channel', async () => {
    const h = harness();
    h.call('push:setSecret', 'ntfy.topic', TOPIC);
    await expect(h.call('push:test', 'push')).resolves.toEqual({ ok: true });
  });

  it('refuses an unknown channel instead of guessing', async () => {
    const h = harness();
    await expect(h.call('push:test', 'carrier-pigeon')).resolves.toMatchObject({ ok: false });
    expect(h.logs.some((l) => l.msg.includes('unknown channel'))).toBe(true);
  });
});
