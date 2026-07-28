import { describe, it, expect } from 'vitest';
import { ContributionRegistry } from '../../../shared/extensibility/registry';
import { RendererContributions } from './contributions';
import { buildContributedCommands, BuildProblem } from './commands';
import { Command } from '../lib/commands';
import { CommandDeps } from '../lib/command-set';

const DEPS = {} as CommandDeps; // never called: these sets ignore their deps

function cmd(id: string, binding?: string): Command {
  return { id, titleKey: `t.${id}`, categoryKey: 't.cat', scope: 'app', binding, run: () => {} };
}

function set(id: string, build: () => Command[]) {
  return {
    manifest: { id, displayName: id, version: '1.0.0', capabilities: ['commands.contribute'] },
    build,
  };
}

function registryWith(...sets: ReturnType<typeof set>[]) {
  const r = new ContributionRegistry<RendererContributions>();
  for (const s of sets) r.register('command-set', s);
  return r;
}

describe('buildContributedCommands', () => {
  it('flattens sets in registration order', () => {
    const problems: BuildProblem[] = [];
    const out = buildContributedCommands(
      registryWith(set('first', () => [cmd('a')]), set('second', () => [cmd('b')])),
      DEPS,
      (p) => problems.push(p)
    );
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(problems).toEqual([]);
  });

  it('a set that THROWS is skipped, not fatal — the others still ship', () => {
    // this runs during App's render: an uncaught throw here unmounts the tree
    // and blanks the window, which is precisely what the seam must not allow
    const problems: BuildProblem[] = [];
    const out = buildContributedCommands(
      registryWith(
        set('broken', () => {
          throw new Error('contributor bug');
        }),
        set('good', () => [cmd('survivor')])
      ),
      DEPS,
      (p) => problems.push(p)
    );
    expect(out.map((c) => c.id)).toEqual(['survivor']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ setId: 'broken', kind: 'threw' });
    expect(problems[0].detail).toMatch(/contributor bug/);
  });

  it('a duplicate command id is dropped and reported — first registration wins', () => {
    const problems: BuildProblem[] = [];
    const out = buildContributedCommands(
      registryWith(set('first', () => [cmd('same')]), set('second', () => [cmd('same')])),
      DEPS,
      (p) => problems.push(p)
    );
    expect(out).toHaveLength(1);
    expect(problems[0]).toMatchObject({ setId: 'second', kind: 'duplicate-id' });
  });

  it('a duplicate BINDING is reported but the command still ships', () => {
    // §5.8: hiding chrome never removes capability — a shadowed accelerator
    // must still leave the command reachable from the palette
    const problems: BuildProblem[] = [];
    const out = buildContributedCommands(
      registryWith(
        set('first', () => [cmd('a', 'Mod+K')]),
        set('second', () => [cmd('b', 'Mod+K')])
      ),
      DEPS,
      (p) => problems.push(p)
    );
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(problems[0]).toMatchObject({ setId: 'second', kind: 'duplicate-binding' });
  });

  it('the real seed set flattens with no problems at all', () => {
    const problems: BuildProblem[] = [];
    // guards against the seed set itself carrying a collision
    const out = buildContributedCommands(
      registryWith(set('core', () => [cmd('x', 'Mod+1'), cmd('y', 'Mod+2')])),
      DEPS,
      (p) => problems.push(p)
    );
    expect(out).toHaveLength(2);
    expect(problems).toEqual([]);
  });
});
