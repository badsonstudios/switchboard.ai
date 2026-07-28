// @vitest-environment jsdom
// Registering panels pulls in the real view components (xterm, Monaco), which
// touch the DOM at module scope — so this file needs a DOM even though it
// asserts nothing about rendering.
import { describe, it, expect } from 'vitest';

import { ContributionRegistry } from '../../shared/extensibility/registry';
import { RendererContributions } from './extensibility/contributions';
import { createRendererRegistry, registerBuiltinContributions } from './bootstrap';
import { CommandDeps } from './lib/command-set';

// Deps are all no-ops: this file cares that commands ARRIVE through the
// registry, not what they do. Behaviour lives in command-set.test.ts.
function noopDeps(): CommandDeps {
  return {
    focusCard: () => {},
    newSession: () => {},
    closeCard: () => {},
    toggleCardView: () => {},
    popOutCard: () => {},
    toggleRail: () => {},
    openPalette: () => {},
    toggleTabRows: () => {},
    jumpToNextAttention: () => {},
  };
}

describe('renderer bootstrap (§5.23)', () => {
  it('registers the built-in command set at the command-set point', () => {
    const r = createRendererRegistry();
    const sets = r.list('command-set');
    expect(sets).toHaveLength(1);
    expect(sets[0].manifest.id).toBe('core-commands');
    expect(sets[0].manifest.capabilities).toContain('commands.contribute');
  });

  it('commands resolve by point + id — the consumer never imports the contributor', () => {
    const r = createRendererRegistry();
    const set = r.resolve('command-set', 'core-commands');
    expect(set).toBeDefined();
    const commands = set!.build(noopDeps());
    expect(commands.length).toBeGreaterThan(0);
    // the seed set the palette and dispatcher both read
    expect(commands.map((c) => c.id)).toContain('palette.open');
  });

  it('every contributed command carries a stable id (the resolve key)', () => {
    const commands = createRendererRegistry()
      .list('command-set')
      .flatMap((c) => c.build(noopDeps()));
    const ids = commands.map((c) => c.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size, 'duplicate command ids').toBe(ids.length);
  });

  it('takes a registry rather than a singleton, so tests never leak into each other', () => {
    const a = new ContributionRegistry<RendererContributions>();
    registerBuiltinContributions(a);
    const b = new ContributionRegistry<RendererContributions>();
    expect(a.list('command-set')).toHaveLength(1);
    expect(b.list('command-set')).toHaveLength(0);
    // and registering twice into the SAME registry is still the duplicate error
    expect(() => registerBuiltinContributions(a)).toThrow(/duplicate/);
  });
});
