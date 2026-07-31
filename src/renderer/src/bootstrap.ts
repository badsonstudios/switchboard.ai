// Renderer bootstrap: the ONLY module allowed to import contributors directly
// — it populates the registry; everyone else resolves through it (§5.23).
// Same RULE as src/main/bootstrap.ts, deliberately not the same shape: main's
// registerBuiltinContributions() takes no argument and mutates a module
// singleton, which cannot be called from a component (StrictMode renders
// twice, and the second pass would throw `duplicate contribution`). Taking the
// registry as an argument keeps it callable from a test with a fresh instance.
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { RendererContributions } from './extensibility/contributions';
import { RendererRegistry, rendererRegistry } from './extensibility/registry-instance';
import { buildCommands } from './lib/command-set';
import { feedBlockRenderers } from './extensibility/feed-blocks';
import { statusBarItems } from './extensibility/status-bar-items';
import { sessionPanels } from './extensibility/panels';
import { themeContributions } from './extensibility/themes';

export type { RendererRegistry } from './extensibility/registry-instance';

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
  for (const r of feedBlockRenderers) registry.register('feed-block-renderer', r);
  for (const i of statusBarItems) registry.register('status-bar-item', i);
  for (const p of sessionPanels) registry.register('panel', p);
  for (const th of themeContributions) registry.register('theme', th);
}

/**
 * What registered, in the app log. Main does the same for its own manifests
 * (`index.ts`: "contributions registered"); the renderer's console is piped
 * into the same log by the `console-message` handler, so this needs no IPC.
 */
export function logManifests(registry: RendererRegistry): void {
  // one greppable line per contribution rather than a single 15-entry blob
  const ids = registry.manifests().map((m) => `${m.point}/${m.manifest.id}`);
  console.info(`renderer contributions registered (${ids.length}): ${ids.join(', ')}`);
}

/** Populate the app's registry. Called once, at the entry point. */
export function initRendererContributions(): RendererRegistry {
  registerBuiltinContributions(rendererRegistry);
  logManifests(rendererRegistry);
  return rendererRegistry;
}
