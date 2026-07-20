// In-process contribution registry (§5.23). Consumers resolve contracts by
// contribution point + id (or capability) — never by importing a contributor
// module directly. That rule is what keeps the seam real.
import { CapabilityManifest, ContributionContracts, ContributionPointId } from './contributions';

type Registered<P extends ContributionPointId> = ContributionContracts[P];

export class ContributionRegistry {
  private readonly points = new Map<ContributionPointId, Map<string, { manifest: CapabilityManifest }>>();

  register<P extends ContributionPointId>(point: P, contribution: Registered<P>): void {
    const byId = this.points.get(point) ?? new Map();
    const id = contribution.manifest.id;
    if (byId.has(id)) {
      throw new Error(`duplicate contribution "${id}" at point "${point}"`);
    }
    byId.set(id, contribution);
    this.points.set(point, byId);
  }

  resolve<P extends ContributionPointId>(point: P, id: string): Registered<P> | undefined {
    return this.points.get(point)?.get(id) as Registered<P> | undefined;
  }

  /** All contributions at a point, optionally filtered by capability. */
  list<P extends ContributionPointId>(point: P, capability?: string): Registered<P>[] {
    const all = [...(this.points.get(point)?.values() ?? [])] as Registered<P>[];
    return capability
      ? all.filter((c) => c.manifest.capabilities.includes(capability))
      : all;
  }

  manifests(): Array<{ point: ContributionPointId; manifest: CapabilityManifest }> {
    return [...this.points.entries()].flatMap(([point, byId]) =>
      [...byId.values()].map((c) => ({ point, manifest: c.manifest }))
    );
  }
}

/** The app-wide registry instance, populated at bootstrap. */
export const registry = new ContributionRegistry();
