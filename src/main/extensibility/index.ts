// Main's registry instance. The CLASS is shared with the renderer
// (src/shared/extensibility/registry.ts); the contracts map is main's own, so
// a renderer point can never be registered here by mistake and vice versa.
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions } from './contributions';

export type MainRegistry = ContributionRegistry<MainContributions>;

/** The app-wide registry instance, populated at bootstrap. */
export const registry: MainRegistry = new ContributionRegistry<MainContributions>();
