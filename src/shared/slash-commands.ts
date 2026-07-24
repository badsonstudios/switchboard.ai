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
