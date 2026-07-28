// In-process contribution registry (§5.23). Consumers resolve contracts by
// contribution point + id (or capability) — never by importing a contributor
// module directly. That rule is what keeps the seam real.
//
// PROCESS-AGNOSTIC ON PURPOSE (P2-E15-09's sibling, AR-P0-2): this module
// imports nothing from `main/` or `renderer/`, because both run their own
// instance. Main registers provider adapters; the renderer registers commands
// (and, from P2-E15-03, panels and block renderers). Same mechanics, different
// vocabulary — so the CONTRACTS MAP is a type parameter rather than a fixed
// union. Baking every point into one map here is what made the seam
// main-only: a renderer point could not be added without dragging renderer
// types into shared code.

/** What a contributor declares about itself. */
export interface CapabilityManifest {
  /** unique id, kebab-case, e.g. "claude-code" */
  id: string;
  displayName: string;
  version: string;
  /** capability strings, e.g. "sessions.spawn", "commands.contribute" */
  capabilities: string[];
}

/** Every contribution, whatever the point, declares a manifest. */
export interface Contribution {
  manifest: CapabilityManifest;
}

/** A process's contribution points: point id -> the contract it accepts. */
export type ContributionMap = Record<string, Contribution>;

export class ContributionRegistry<C extends ContributionMap> {
  private readonly points = new Map<string, Map<string, Contribution>>();

  register<P extends keyof C & string>(point: P, contribution: C[P]): void {
    const byId = this.points.get(point) ?? new Map<string, Contribution>();
    const id = contribution.manifest.id;
    if (byId.has(id)) {
      throw new Error(`duplicate contribution "${id}" at point "${point}"`);
    }
    byId.set(id, contribution);
    this.points.set(point, byId);
  }

  resolve<P extends keyof C & string>(point: P, id: string): C[P] | undefined {
    return this.points.get(point)?.get(id) as C[P] | undefined;
  }

  /** All contributions at a point, optionally filtered by capability. */
  list<P extends keyof C & string>(point: P, capability?: string): C[P][] {
    const all = [...(this.points.get(point)?.values() ?? [])] as C[P][];
    return capability ? all.filter((c) => c.manifest.capabilities.includes(capability)) : all;
  }

  manifests(): Array<{ point: string; manifest: CapabilityManifest }> {
    return [...this.points.entries()].flatMap(([point, byId]) =>
      [...byId.values()].map((c) => ({ point, manifest: c.manifest }))
    );
  }
}
