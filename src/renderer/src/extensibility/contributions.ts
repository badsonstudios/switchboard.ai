// The RENDERER's contribution vocabulary (§5.23, AR-P0-2). Mirror image of
// src/main/extensibility/contributions.ts: same registry class from
// src/shared, a contracts map of its own.
//
// Why this exists at all: §5.23 lists nine first-party extensions and eight of
// them are renderer contributions — view tabs, feed block renderers, status bar
// items, themes. Before this there was no renderer-side seam whatsoever, so the
// Phase-4 gate ("2–3 dissimilar internal consumers on the seams") was
// unreachable by construction: the count was 1 and could not grow.
//
// `command-set` is the first, and it is not a new abstraction — lib/commands.ts
// was already a contribution point in everything but name (register a thing,
// resolve it by id, never import the contributor). P2-E15-03 adds `panel`,
// `feed-block-renderer` and `status-bar-item` to this map.
import { CapabilityManifest } from '../../../shared/extensibility/registry';
import { Command } from '../lib/commands';
import { CommandDeps } from '../lib/command-set';

/**
 * A set of commands. Built lazily from deps rather than supplied as a list:
 * every command closes over app callbacks (focus a card, open the palette),
 * which do not exist at registration time.
 */
export interface CommandSetContribution {
  manifest: CapabilityManifest;
  build(deps: CommandDeps): Command[];
}

// A type alias, not `interface ... extends ContributionMap` — see the twin
// comment in main's contributions.ts for why that distinction is load-bearing.
//
// Precedence, because the registry dedupes CONTRIBUTION ids and not the
// commands inside them: sets are flattened in registration order, and both
// `dispatch` and `bindingFor` take the FIRST match. So command ids and
// accelerators must be unique across sets; earlier registration wins, and
// App logs a warning when it sees a collision.
export type RendererContributions = {
  'command-set': CommandSetContribution;
};
