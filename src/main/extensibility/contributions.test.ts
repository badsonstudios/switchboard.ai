import { describe, it, expect } from 'vitest';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions } from './contributions';
import { claudeAdapter } from '../providers/claude';

// The registry MECHANICS are tested in shared/extensibility/registry.test.ts.
// This file covers main's half: that main's own contributors satisfy main's
// contracts and are reachable the way consumers actually reach them.
describe('main contributions', () => {
  it('the claude adapter is resolvable via the registry, never by direct import', () => {
    const r = new ContributionRegistry<MainContributions>();
    r.register('provider-adapter', claudeAdapter);
    const adapter = r.resolve('provider-adapter', 'claude-code');
    expect(adapter).toBeDefined();
    expect(adapter!.manifest.capabilities).toContain('sessions.spawn');
    // spawn-recipe behavior is covered in providers/claude.test.ts
  });
});
