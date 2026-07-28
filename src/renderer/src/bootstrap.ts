// Renderer bootstrap: the ONLY module allowed to import contributors directly
// — it populates the registry; everyone else resolves through it (§5.23).
// Same RULE as src/main/bootstrap.ts, deliberately not the same shape: main's
// registerBuiltinContributions() takes no argument and mutates a module
// singleton, which cannot be called from a component (StrictMode renders
// twice, and the second pass would throw `duplicate contribution`). Taking the
// registry as an argument keeps it callable from a test with a fresh instance.
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { RendererContributions } from './extensibility/contributions';
import { buildCommands } from './lib/command-set';

export type RendererRegistry = ContributionRegistry<RendererContributions>;

/** A registry with the built-in renderer contributions registered. */
export function createRendererRegistry(): RendererRegistry {
  const registry = new ContributionRegistry<RendererContributions>();
  registerBuiltinContributions(registry);
  return registry;
}

/** Takes the registry rather than reaching for a module singleton, so a test
 *  can build a fresh one and nothing leaks between them. */
export function registerBuiltinContributions(registry: RendererRegistry): void {
  registry.register('command-set', {
    manifest: {
      id: 'core-commands',
      displayName: 'Core commands',
      version: '1.0.0',
      capabilities: ['commands.contribute'],
    },
    build: buildCommands,
  });
}

/**
 * The renderer's registry instance. Module scope, not a `useMemo` inside a
 * component: `useMemo` is a performance hint React may discard, and P2-E15-03
 * resolves `panel` and `feed-block-renderer` contributions deep inside
 * SessionGrid and FeedView, which would then mean prop-drilling or a context
 * retrofit. Module init runs exactly once, so this is StrictMode-safe.
 */
export const rendererRegistry: RendererRegistry = createRendererRegistry();
