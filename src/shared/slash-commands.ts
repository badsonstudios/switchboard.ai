// Slash-command model + pure helpers (P2-E10-07, §5.10/§5.17). Shared between
// the main-process scanner (which discovers commands) and the renderer's
// composer popup (which filters and inserts them). The commands themselves are
// ALWAYS executed by the real CLI — we only help type them
// (host-don't-reimplement).

export type SlashCommandSource =
  | 'builtin'
  | 'project-command'
  | 'user-command'
  | 'project-skill'
  | 'user-skill';

export interface SlashCommand {
  /** command name WITHOUT the leading slash, e.g. "clear" or "frontend:component" */
  name: string;
  description?: string;
  source: SlashCommandSource;
}

/**
 * The token the popup should complete, or null when no popup belongs on
 * screen. CLI semantics: a slash command is LINE-INITIAL — the draft's first
 * character must be '/' and the caret must still be inside that first token
 * ("no popup when '/' is mid-sentence", issue #68 done-when).
 */
export function slashToken(draft: string, caret: number): string | null {
  if (!draft.startsWith('/')) return null;
  if (caret < 1) return null; // caret before/at the '/' — nothing typed yet
  const head = draft.slice(0, caret);
  if (/\s/.test(head)) return null; // caret has left the first token
  return head.slice(1); // '' right after '/', else the partial name
}

/**
 * Filter + rank for the popup: case-insensitive substring match,
 * prefix matches first, then alphabetical.
 */
export function filterCommands(list: SlashCommand[], token: string): SlashCommand[] {
  const q = token.toLowerCase();
  return list
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
}

/**
 * Replace the slash token being completed with the picked command and a
 * trailing space, keeping whatever already follows the caret (without
 * doubling a space the draft already has there).
 */
export function insertCommand(draft: string, caret: number, name: string): string {
  const rest = draft.slice(caret);
  return `/${name}${/^\s/.test(rest) ? '' : ' '}${rest}`;
}

/**
 * Merge discovery sources into one list, deduped by name. Precedence mirrors
 * the CLI: builtins are never shadowed; a project command beats a user
 * command of the same name; commands beat skills.
 */
const SOURCE_RANK: Record<SlashCommandSource, number> = {
  builtin: 0,
  'project-command': 1,
  'user-command': 2,
  'project-skill': 3,
  'user-skill': 4,
};

export function mergeCommands(...lists: SlashCommand[][]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const c of lists.flat()) {
    const key = c.name.toLowerCase();
    const prior = byName.get(key);
    if (!prior || SOURCE_RANK[c.source] < SOURCE_RANK[prior.source]) byName.set(key, c);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One command as the CLI itself advertises it (P2-E18-09).
 *
 * `description` is optional because the two payloads that carry commands do not
 * agree on fidelity, and that difference is measured, not assumed:
 *
 * - `system:init.slash_commands` is an array of plain NAMES (S-10 probe C: 59
 *   entries, joined with a comma).
 * - `system:commands_changed.commands` is an array of OBJECTS carrying
 *   `description`, `argumentHint` and `aliases` (read out of the shipped VS Code
 *   extension, which does `latestCommands = e.commands` and then renders
 *   `.description` / `.argumentHint` off each entry).
 *
 * The extension's richer list comes from the `initialize` control-request
 * RESPONSE, which we do not send — so `init` is names-only for us by
 * construction, not by accident.
 */
export interface CliCommand {
  name: string;
  description?: string;
}

/**
 * What the composer should offer when the CLI has told us its real command set.
 *
 * The CLI's list is the SET — it knows about plugin commands, `--add-dir`
 * roots, and its own version's builtins, none of which we can enumerate. Our
 * own knowledge (the curated builtins + the `.claude/` scan) becomes a
 * DESCRIPTION AND PROVENANCE lookup over that set.
 *
 * Consequences, both wanted:
 * - a command we know but the CLI does not advertise DISAPPEARS. That is the
 *   point: a stale curated entry is exactly what this item deletes.
 * - a command the CLI advertises that we cannot classify still appears, tagged
 *   `builtin` — "came with Claude Code, not from a file in your project", which
 *   is what that badge means to a reader.
 *
 * A CLI-supplied description beats ours (it is ground truth for that version);
 * ours fills in when the CLI gave only a name, which is the `init` case and
 * therefore the common one.
 */
export function commandsFromCli(cli: CliCommand[], known: SlashCommand[]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const k of known) byName.set(k.name.toLowerCase(), k);

  const out = new Map<string, SlashCommand>();
  for (const c of cli) {
    const name = c.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    // First wins. Duplicate names are REAL — the shipped extension counts them
    // and, where a name occurs more than once, types the alias ending in
    // `:<name>` instead, so two plugins can both offer `/review`. We do not
    // carry `aliases`, so a duplicate collapses to one row here. Acceptable
    // because the popup only helps you TYPE: the CLI resolves what it receives,
    // exactly as it would if you had typed it yourself. Carrying aliases and
    // mirroring that rule is the fix if it ever bites.
    if (out.has(key)) continue;
    const k = byName.get(key);
    out.set(key, {
      // the CLI's own spelling is what you type
      name,
      source: k?.source ?? 'builtin',
      description: c.description ?? k?.description,
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
