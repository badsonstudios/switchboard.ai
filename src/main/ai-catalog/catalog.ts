// The built-in catalog of AIs (E40 item 08, #1291; design record §4 "As
// built, item 08").
//
// SHIPS INSIDE THE APP. `catalog.json` is the native Claude Code entry plus
// the ACP registry entries we vouch for, copied from the 2026-10-15 registry
// snapshot (`registry-snapshot.json`, which is ALL 42 registry agents, trimmed,
// and is what "Check for new AIs" diffs against). Nothing here touches the
// network; refreshing is `registry-refresh.ts`, on a user press only.
//
// What the registry gives and what we add:
//   - from the registry: id, name, version, description, maker (`authors[0]`),
//     license, website, and the launch (`npx -y <package> <args>`, or a
//     binary's `cmd` basename and its `args`);
//   - ours: how to install it (a command to copy, or the maker's page), which
//     program on PATH means "installed", `runsLocalModels`, the icon file
//     (downloaded once from the registry CDN into `src/renderer/public/
//     ai-icons/`, served from the renderer's own origin), and
//     which provider id hosts it (Claude's native engine; Codex is #1290's).
import { CLAUDE_AI_ID, type CatalogEntry, type RegistryAgent } from '../../shared/ais';
import catalogJson from './catalog.json';
import snapshotJson from './registry-snapshot.json';

/** The registry snapshot the catalog was copied from. */
export const CATALOG_SNAPSHOT_DATE: string = catalogJson.snapshot;

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/** The provider id of Claude's native engine. */
export const CLAUDE_CATALOG_ID = CLAUDE_AI_ID;

const ENTRIES: readonly CatalogEntry[] = Object.freeze(
  (catalogJson.entries as unknown as CatalogEntry[]).map((e) => Object.freeze({ ...e }))
);

/** Every entry, Claude first. */
export function catalogEntries(): readonly CatalogEntry[] {
  return ENTRIES;
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return ENTRIES.find((e) => e.id === id);
}

/** The catalog entry a provider hosts, if any. */
export function catalogEntryForProvider(providerId: string): CatalogEntry | undefined {
  return ENTRIES.find((e) => e.providerId === providerId);
}

/** The shipped registry snapshot, trimmed. */
export function shippedRegistry(): readonly RegistryAgent[] {
  return snapshotJson.agents;
}
