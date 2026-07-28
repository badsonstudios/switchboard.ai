// The renderer's registry INSTANCE, and nothing else.
//
// Separate from bootstrap.ts to break an import cycle: bootstrap imports the
// contributors, contributors import the view components, and the view
// components need the registry to resolve their own contributions. Importing
// the instance from bootstrap closed that ring — it happened to work only
// because nothing read `rendererRegistry` at module scope, so the binding was
// still in its temporal dead zone while the ring evaluated. One module-level
// `rendererRegistry.list(...)` anywhere in it would have thrown at window open
// with a stack pointing nowhere useful.
//
// This module imports only the class, so consumers can depend on it freely.
// Main has the same split: `main/extensibility/index.ts` owns the instance,
// `main/bootstrap.ts` fills it.
import { ContributionRegistry } from '../../../shared/extensibility/registry';
import { RendererContributions } from './contributions';

export type RendererRegistry = ContributionRegistry<RendererContributions>;

/** Empty until `registerBuiltinContributions()` runs at the entry point. */
export const rendererRegistry: RendererRegistry = new ContributionRegistry<RendererContributions>();
