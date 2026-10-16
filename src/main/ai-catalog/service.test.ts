// The AIs model (#1291): the list with status (a done-when), the default
// (a done-when), custom-AI add / remove / Test, and sign-in routing. Providers
// are plain objects here; nothing is spawned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AisSnapshot, CustomAi } from '../../shared/ais';
import { AisStore } from './ais-store';
import { AiCatalogService, type AiCatalogDeps, type ProviderView } from './service';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ai-service-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = () => ({ info: vi.fn(), warn: vi.fn() });

function setup(over: Partial<AiCatalogDeps> = {}, initial: ProviderView[] = []) {
  const providers: ProviderView[] = [
    {
      id: 'claude-code',
      displayName: 'Claude Code',
      detect: {
        detect: () => Promise.resolve({ installed: true, version: '2.1.288', login: 'logged-in', plan: 'max' }),
        login: () => Promise.resolve({ supported: false, reason: 'terminal' }),
      },
    },
    ...initial,
  ];
  const store = new AisStore(dir, log());
  store.load();
  const pushes: AisSnapshot[] = [];
  const registered: CustomAi[] = [];
  const deps: AiCatalogDeps = {
    store,
    providers: () => providers,
    registerCustom: (ai) => {
      if (providers.some((p) => p.id === ai.id)) return false;
      registered.push(ai);
      providers.push({ id: ai.id, displayName: ai.name, detect: { detect: () => Promise.resolve({ installed: false, login: 'unknown' }) } });
      return true;
    },
    unregisterCustom: (id) => {
      const i = providers.findIndex((p) => p.id === id);
      if (i >= 0) providers.splice(i, 1);
      return i >= 0;
    },
    testCommand: vi.fn(() => Promise.resolve({ ok: true, agentName: 'fake-acp', protocolVersion: 1, ms: 5 })),
    checkRegistry: vi.fn(() => Promise.resolve({ ok: false as const, error: 'offline' })),
    lastRegistryCheck: () => null,
    push: (s) => pushes.push(s),
    log: log(),
    find: (c) => (c === 'gemini' ? '/usr/bin/gemini' : null),
    ...over,
  };
  return { service: new AiCatalogService(deps), store, providers, pushes, registered, deps };
}

describe('the list with status', () => {
  it('every catalog AI, then custom AIs, then any other registered provider; detection after a run', async () => {
    const { service, pushes } = setup({}, [
      { id: 'fake-acp', displayName: 'Fake ACP', detect: { detect: () => Promise.resolve({ installed: true, version: '0.0.0', login: 'logged-out' }) } },
    ]);
    const before = service.list();
    expect(before[0]).toMatchObject({ kind: 'catalog', entry: { id: 'claude-code' }, providerId: 'claude-code', registered: true });
    expect(before[0]).not.toHaveProperty('detection');
    expect(before.find((i) => i.entry.id === 'codex-acp')).toMatchObject({ providerId: 'codex', registered: false });
    expect(before.at(-1)).toMatchObject({ kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, registered: true });

    const snap = await service.detectAll('startup');
    const by = (id: string) => snap.items.find((i) => i.entry.id === id)!;
    // a registered provider answers through its own `detect`
    expect(by('claude-code').detection).toMatchObject({ installed: true, version: '2.1.288', login: 'logged-in', plan: 'max' });
    expect(by('fake-acp').detection).toMatchObject({ installed: true, login: 'logged-out' });
    // a catalog AI with no provider: the PATH scan for its command
    expect(by('gemini').detection).toMatchObject({ installed: true, login: 'unknown' });
    expect(by('goose').detection).toMatchObject({ installed: false, login: 'unknown' });
    // one push said "detecting", the last one carries the answers
    expect(pushes[0].detecting).toBe(true);
    expect(pushes.at(-1)!.detecting).toBe(false);
    expect(pushes.at(-1)!.items.find((i) => i.entry.id === 'claude-code')!.detection?.installed).toBe(true);
  });
});

describe('the default AI', () => {
  it('never chosen: Claude (the first registered)', () => {
    expect(setup().service.defaultState()).toEqual({ id: 'claude-code', fellBack: false });
  });

  it('choose a registered one; refuse one that is not', () => {
    const { service, store, pushes } = setup({}, [{ id: 'fake-acp', displayName: 'Fake ACP' }]);
    expect(service.setDefault('nope')).toEqual({ ok: false, error: 'That AI is not set up here.' });
    expect(service.setDefault('fake-acp')).toEqual({ ok: true, default: { id: 'fake-acp', chosen: 'fake-acp', fellBack: false } });
    expect(service.defaultProviderId()).toBe('fake-acp');
    expect(store.defaultAi()).toBe('fake-acp');
    expect(pushes.at(-1)!.default.id).toBe('fake-acp');
  });

  it('a stored default that is not registered falls back to Claude, and the state says so', () => {
    const { service, store } = setup();
    store.setDefaultAi('codex');
    expect(service.defaultState()).toEqual({ id: 'claude-code', chosen: 'codex', fellBack: true });
    expect(service.defaultProviderId()).toBe('claude-code');
  });
});

describe('custom AIs', () => {
  it('add: validated, registered as a provider at once, persisted, and probed', async () => {
    const { service, store, registered } = setup();
    const r = await service.addCustom({ name: 'My local Qwen', command: 'opencode', args: ['acp', '--model', 'ollama/qwen3-coder'] });
    expect(r).toMatchObject({ ok: true, ai: { id: 'custom:my-local-qwen', name: 'My local Qwen', command: 'opencode' } });
    expect(registered.map((a) => a.id)).toEqual(['custom:my-local-qwen']);
    expect(store.customAis().map((a) => a.id)).toEqual(['custom:my-local-qwen']);
    const item = service.list().find((i) => i.entry.id === 'custom:my-local-qwen');
    expect(item).toMatchObject({ kind: 'custom', providerId: 'custom:my-local-qwen', registered: true, detection: { installed: false } });
  });

  it('add: a bad draft is refused with the reason, and nothing is registered', async () => {
    const { service, registered } = setup();
    expect(await service.addCustom({ name: 'x', command: 'x', args: ['a&calc'] })).toMatchObject({ ok: false });
    expect(registered).toEqual([]);
  });

  it('two with the same name get different ids', async () => {
    const { service } = setup();
    await service.addCustom({ name: 'Qwen', command: 'q' });
    const second = await service.addCustom({ name: 'Qwen', command: 'q' });
    expect(second).toMatchObject({ ok: true, ai: { id: 'custom:qwen-2' } });
  });

  it('persisted ones are registered at startup', async () => {
    const first = setup();
    await first.service.addCustom({ name: 'Gemini work', command: 'gemini', args: ['--acp'] });
    const second = setup();
    second.service.registerPersisted();
    expect(second.registered.map((a) => a.id)).toEqual(['custom:gemini-work']);
  });

  it('remove: unregistered, forgotten, and a default that named it is cleared', async () => {
    const { service, store, providers } = setup();
    await service.addCustom({ name: 'Qwen', command: 'q' });
    service.setDefault('custom:qwen');
    expect(service.removeCustom('custom:qwen')).toBe(true);
    expect(providers.some((p) => p.id === 'custom:qwen')).toBe(false);
    expect(store.customAis()).toEqual([]);
    expect(store.defaultAi()).toBeUndefined();
    expect(service.defaultState()).toEqual({ id: 'claude-code', fellBack: false });
    expect(service.removeCustom('custom:qwen')).toBe(false);
    expect(service.removeCustom('claude-code')).toBe(false);
  });

  it('Test: validated, then handed to the engine with a signal', async () => {
    const { service, deps } = setup();
    expect(await service.testCustom({ name: 'x', command: 'x', args: ['a|b'] })).toMatchObject({ ok: false, ms: 0 });
    expect(deps.testCommand).not.toHaveBeenCalled();
    const r = await service.testCustom({ name: 'x', command: 'node', args: ['agent.js'] });
    expect(r).toEqual({ ok: true, agentName: 'fake-acp', protocolVersion: 1, ms: 5 });
    expect(deps.testCommand).toHaveBeenCalledWith({ command: 'node', args: ['agent.js'] }, { signal: expect.any(AbortSignal) as unknown });
  });

  it('dispose aborts a Test in flight (app quit), so the engine kills its child', async () => {
    let seen: AbortSignal | undefined;
    const { service } = setup({
      testCommand: (_cmd, opts) => {
        seen = opts.signal;
        return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled', ms: 1 })));
      },
    });
    const p = service.testCustom({ name: 'x', command: 'node' });
    service.dispose();
    expect(seen?.aborted).toBe(true);
    expect(await p).toMatchObject({ error: 'cancelled' });
  });
});

describe('dispose (app quit)', () => {
  it('ends the startup detection run at once, so its probes kill what they started', async () => {
    let seen: AbortSignal | undefined;
    const { service } = setup({}, [
      {
        id: 'slow',
        displayName: 'Slow',
        detect: {
          detect: (signal) => {
            seen = signal;
            return new Promise(() => {});
          },
        },
      },
    ]);
    const p = service.detectAll('startup');
    service.dispose();
    const snap = await p;
    expect(seen?.aborted).toBe(true);
    expect(snap.items.find((i) => i.entry.id === 'slow')?.detection?.detail).toBe('the check was cancelled');
  });
});

describe('sign-in', () => {
  it('an AI whose detect has no login: not supported, with the reason', async () => {
    const { service } = setup({}, [{ id: 'fake-stream', displayName: 'Fake' }]);
    expect(await service.login('fake-stream')).toMatchObject({ supported: false });
    expect(await service.login('nope')).toEqual({ supported: false, reason: 'That AI is not set up here.' });
  });

  it('Claude answers for itself (not driven from here)', async () => {
    expect(await setup().service.login('claude-code')).toEqual({ supported: false, reason: 'terminal' });
  });

  it('a capability that throws synchronously is a failed sign-in, and the next press runs again', async () => {
    let calls = 0;
    const { service } = setup({}, [
      {
        id: 'fake-acp',
        displayName: 'Fake ACP',
        detect: {
          detect: () => Promise.resolve({ installed: true, login: 'logged-in' }),
          login: () => {
            calls++;
            throw new Error('sync boom');
          },
        },
      },
    ]);
    expect(await service.login('fake-acp')).toMatchObject({ supported: true, ok: false, reason: 'Error: sync boom' });
    await service.login('fake-acp');
    expect(calls).toBe(2);
  });

  it('one sign-in at a time per AI; the method is passed through', async () => {
    const login = vi.fn(() => new Promise<{ supported: true; ok: true }>((r) => setTimeout(() => r({ supported: true, ok: true }), 10)));
    const { service } = setup({}, [{ id: 'fake-acp', displayName: 'Fake ACP', detect: { detect: () => Promise.resolve({ installed: true, login: 'logged-in' }), login } }]);
    const a = service.login('fake-acp', 'fake-login');
    const b = service.login('fake-acp');
    expect(b).toBe(a);
    expect(await a).toEqual({ supported: true, ok: true });
    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith(expect.any(AbortSignal), 'fake-login');
  });
});

describe('the registry check', () => {
  it('only runs when asked, and is logged', async () => {
    const { service, deps } = setup();
    await service.detectAll('startup');
    expect(deps.checkRegistry).not.toHaveBeenCalled();
    expect(await service.checkRegistry()).toEqual({ ok: false, error: 'offline' });
    expect(deps.checkRegistry).toHaveBeenCalledTimes(1);
  });
});
