import { describe, it, expect } from 'vitest';
import { ContributionRegistry } from './registry';
import { ProviderAdapter } from './contributions';
import { claudeAdapter } from '../providers/claude';

function fakeAdapter(id: string, capabilities: string[] = ['sessions.spawn']): ProviderAdapter {
  return {
    manifest: { id, displayName: id, version: '0.0.0', capabilities },
    buildSpawn: () => ({ command: 'x', args: [], env: {} }),
  };
}

describe('ContributionRegistry', () => {
  it('registers and resolves by point + id', () => {
    const r = new ContributionRegistry();
    r.register('provider-adapter', fakeAdapter('a'));
    expect(r.resolve('provider-adapter', 'a')?.manifest.id).toBe('a');
    expect(r.resolve('provider-adapter', 'nope')).toBeUndefined();
  });

  it('rejects duplicate ids at the same point', () => {
    const r = new ContributionRegistry();
    r.register('provider-adapter', fakeAdapter('dup'));
    expect(() => r.register('provider-adapter', fakeAdapter('dup'))).toThrow(/duplicate/);
  });

  it('lists by capability', () => {
    const r = new ContributionRegistry();
    r.register('provider-adapter', fakeAdapter('a', ['sessions.spawn']));
    r.register('provider-adapter', fakeAdapter('b', ['other.cap']));
    const spawners = r.list('provider-adapter', 'sessions.spawn');
    expect(spawners.map((s) => s.manifest.id)).toEqual(['a']);
  });

  it('exposes manifests for future about/debug UI', () => {
    const r = new ContributionRegistry();
    r.register('provider-adapter', fakeAdapter('a'));
    expect(r.manifests()).toEqual([
      { point: 'provider-adapter', manifest: expect.objectContaining({ id: 'a' }) },
    ]);
  });
});

describe('claude adapter through the registry (the done-when)', () => {
  it('is resolvable via the registry and builds a spawn recipe', () => {
    const r = new ContributionRegistry();
    r.register('provider-adapter', claudeAdapter);
    const adapter = r.resolve('provider-adapter', 'claude-code');
    expect(adapter).toBeDefined();
    const recipe = adapter!.buildSpawn({ cwd: 'C:/tmp/x', resumeSessionId: 'abc' });
    expect(recipe.args).toEqual(['--resume', 'abc']);
    // S-01 env landmines scrubbed in the recipe
    expect('ELECTRON_RUN_AS_NODE' in recipe.env).toBe(true);
    expect(recipe.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
