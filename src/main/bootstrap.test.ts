// The runtime half of bootstrap (#1291): a "Something else" AI becomes a real
// provider in the registry — the same one sessions resolve — and only `custom:`
// ids can be taken back out.
import { afterEach, describe, expect, it } from 'vitest';
import { registry } from './extensibility';
import { registerCustomAi, unregisterCustomAi } from './bootstrap';
import type { CustomAi } from '../shared/ais';

const ai: CustomAi = { id: 'custom:bootstrap-test', name: 'Bootstrap test', command: 'node', args: ['agent.js'], addedAt: 1 };

afterEach(() => {
  registry.unregister('provider-adapter', ai.id);
});

describe('registerCustomAi', () => {
  it('registers an ACP provider under the custom id, with the declared capabilities', () => {
    expect(registerCustomAi(ai, '0.8.0')).toBe(true);
    const p = registry.resolve('provider-adapter', ai.id);
    expect(p?.manifest).toMatchObject({ id: ai.id, displayName: 'Bootstrap test' });
    expect(p?.capabilities?.events).toBeDefined();
    expect(p?.capabilities?.controls).toBeDefined();
    expect(p?.capabilities?.detect).toBeDefined();
    const spawn = p!.buildSpawn({ sessionId: 's1', cwd: process.cwd() } as never);
    expect(spawn.args).toEqual(['agent.js']);
    expect(spawn.transport).toBe('stream');
  });

  it('never shadows a provider that is already there', () => {
    expect(registerCustomAi(ai)).toBe(true);
    expect(registerCustomAi(ai)).toBe(false);
  });
});

describe('a custom AI whose program is missing', () => {
  it('fails the spawn with a reason rather than launching the bare name from the project folder', () => {
    const missing = { ...ai, command: 'definitely-not-an-agent-1291' };
    expect(registerCustomAi(missing)).toBe(true);
    const p = registry.resolve('provider-adapter', ai.id)!;
    expect(() => p.buildSpawn({ sessionId: 's2', cwd: process.cwd() } as never)).toThrow(/was not found on this computer/);
  });
});

describe('unregisterCustomAi', () => {
  it('removes a custom one, and refuses anything else', () => {
    registerCustomAi(ai);
    expect(unregisterCustomAi('claude-code')).toBe(false);
    expect(unregisterCustomAi(ai.id)).toBe(true);
    expect(registry.resolve('provider-adapter', ai.id)).toBeUndefined();
  });
});
