import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CapabilityManifest, ContributionRegistry } from './registry';

// Toy contracts, deliberately NOT the app's: this file tests the mechanics,
// which is the whole point of the class living in shared/. If these tests ever
// need to import from main/ or renderer/, the class has drifted back into
// belonging to one process (AR-P0-2).
interface Greeter {
  manifest: CapabilityManifest;
  greet(): string;
}
interface Counter {
  manifest: CapabilityManifest;
  next(): number;
}
// A type alias, NOT `interface ... extends ContributionMap` — extending the
// map inherits its index signature, `keyof C` collapses to `string`, and point
// names stop being checked at every call site. The @ts-expect-error test below
// is what holds this in place.
type TestContributions = {
  greeter: Greeter;
  counter: Counter;
};

function manifest(id: string, capabilities: string[] = ['greet']): CapabilityManifest {
  return { id, displayName: id, version: '0.0.0', capabilities };
}
function greeter(id: string, capabilities?: string[]): Greeter {
  return { manifest: manifest(id, capabilities), greet: () => `hello from ${id}` };
}

function fresh(): ContributionRegistry<TestContributions> {
  return new ContributionRegistry<TestContributions>();
}

describe('ContributionRegistry', () => {
  it('registers and resolves by point + id', () => {
    const r = fresh();
    r.register('greeter', greeter('a'));
    expect(r.resolve('greeter', 'a')?.greet()).toBe('hello from a');
    expect(r.resolve('greeter', 'nope')).toBeUndefined();
  });

  it('rejects duplicate ids at the same point', () => {
    const r = fresh();
    r.register('greeter', greeter('dup'));
    expect(() => r.register('greeter', greeter('dup'))).toThrow(/duplicate/);
  });

  it('the same id at a DIFFERENT point is not a duplicate', () => {
    const r = fresh();
    r.register('greeter', greeter('same'));
    expect(() =>
      r.register('counter', { manifest: manifest('same', ['count']), next: () => 1 })
    ).not.toThrow();
    expect(r.resolve('greeter', 'same')).toBeDefined();
    expect(r.resolve('counter', 'same')).toBeDefined();
  });

  it('lists by capability', () => {
    const r = fresh();
    r.register('greeter', greeter('a', ['greet']));
    r.register('greeter', greeter('b', ['other.cap']));
    expect(r.list('greeter', 'greet').map((g) => g.manifest.id)).toEqual(['a']);
  });

  it('lists everything at a point when no capability is given', () => {
    const r = fresh();
    r.register('greeter', greeter('a'));
    r.register('greeter', greeter('b'));
    expect(r.list('greeter').map((g) => g.manifest.id)).toEqual(['a', 'b']);
  });

  it('an unknown point lists empty rather than throwing (fail-open)', () => {
    expect(fresh().list('counter')).toEqual([]);
  });

  it('exposes manifests for future about/debug UI', () => {
    const r = fresh();
    r.register('greeter', greeter('a'));
    expect(r.manifests()).toEqual([
      { point: 'greeter', manifest: expect.objectContaining({ id: 'a' }) },
    ]);
  });

  it('imports nothing from main/ or renderer/ — the property that makes it shared', () => {
    // ENFORCEMENT is the `no-restricted-imports` rule scoped to src/shared in
    // eslint.config.mjs, which covers every file in here and every import
    // form. This test is executable documentation of the invariant and a
    // backstop for the one file the whole design rests on — it deliberately
    // matches any import form and both quote styles, rather than the tidy
    // `from '...'` case only.
    const src = fs.readFileSync(path.join(__dirname, 'registry.ts'), 'utf8');
    const specifiers = [...src.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1]
    );
    expect(specifiers.filter((i) => /(^|\/)(main|renderer)(\/|$)/.test(i))).toEqual([]);
  });

  it('rejects a point that is not in the contracts map (type-level)', () => {
    const r = fresh();
    // @ts-expect-error — 'nope' is not a key of TestContributions. If the maps
    // are ever declared as `interface X extends ContributionMap` again, they
    // inherit its index signature, `keyof C` collapses to `string`, and this
    // line stops erroring — which is how the check silently died once already.
    r.register('nope', greeter('a'));
    // @ts-expect-error — same, for the read side
    expect(r.resolve('nope', 'a')).toBeDefined();
  });

  it("two registries share the class but never each other's state", () => {
    // main and the renderer each run one of these. Registering into one must
    // never be visible in the other — the bug a module-level singleton invites.
    const a = fresh();
    const b = fresh();
    a.register('greeter', greeter('only-in-a'));
    expect(a.resolve('greeter', 'only-in-a')).toBeDefined();
    expect(b.resolve('greeter', 'only-in-a')).toBeUndefined();
    expect(b.list('greeter')).toEqual([]);
  });
});
