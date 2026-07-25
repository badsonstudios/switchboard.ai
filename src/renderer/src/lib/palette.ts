// What the command palette shows (P2-E9-02). Pure: turns the registry plus the
// live context into ranked, labelled rows — the component only renders them.
//
// Two sources feed it:
//   • the static registry (lib/command-set.ts) — everything the app can do
//   • dynamic "Go to <session>" rows built from the live session list, so a
//     workspace with 12 sessions is navigable by NAME, not just by Ctrl+1..9
//
// A row whose preconditions aren't met still appears — greyed, with the reason
// (§5.8: the palette is the map of what exists, not only of what's available).
import { Command, CommandContext } from './commands';
import { fuzzyRank, FuzzyMatch } from './fuzzy';

export interface PaletteRow {
  id: string;
  /** already-translated label — the component resolves i18n before ranking */
  title: string;
  categoryKey: string;
  binding?: string;
  enabled: boolean;
  disabledReasonKey?: string;
  run: () => void;
  /** matched character positions, for highlighting */
  indices: number[];
}

export interface PaletteSource<Ctx extends CommandContext> {
  commands: Array<Command<Ctx>>;
  ctx: Ctx;
  /** resolves a command's i18n key + params to a display string */
  translate: (key: string, params?: Record<string, unknown>) => string;
  /** focus a session card by id — powers the dynamic "Go to …" rows */
  focusCard: (cardId: string) => void;
}

export const SESSION_ROW_PREFIX = 'palette.session.';
const CATEGORY_GO_TO = 'commands.category.goTo';

/**
 * Every row the palette can show, before filtering: registry commands in their
 * authored order, then one "Go to <title>" row per session in rail order.
 */
export function paletteRows<Ctx extends CommandContext>(src: PaletteSource<Ctx>): PaletteRow[] {
  const rows: PaletteRow[] = src.commands.map((cmd) => {
    let enabled = true;
    try {
      enabled = cmd.enabled ? cmd.enabled(src.ctx) : true;
    } catch {
      enabled = false; // a throwing precondition means "not now", never a crash
    }
    return {
      id: cmd.id,
      title: src.translate(cmd.titleKey, cmd.titleParams),
      categoryKey: cmd.categoryKey,
      binding: cmd.binding,
      enabled,
      disabledReasonKey: cmd.disabledReasonKey,
      run: () => cmd.run(src.ctx),
      indices: [],
    };
  });

  for (const s of src.ctx.sessions) {
    rows.push({
      id: `${SESSION_ROW_PREFIX}${s.id}`,
      title: src.translate('commands.goToSession', { title: s.title }),
      categoryKey: CATEGORY_GO_TO,
      enabled: true,
      run: () => src.focusCard(s.id),
      indices: [],
    });
  }
  return rows;
}

/**
 * Filter + rank rows for a query. Enabled rows sort ahead of disabled ones at
 * equal relevance, so Enter on a fresh query never lands on something inert.
 */
export function filterRows(query: string, rows: PaletteRow[]): PaletteRow[] {
  const ranked = fuzzyRank(query, rows, (r) => r.title);
  const withMatch = ranked.map(({ item, match }: { item: PaletteRow; match: FuzzyMatch }) => ({
    ...item,
    indices: match.indices,
  }));
  // stable partition: enabled first, each group keeping its ranked order
  return [...withMatch.filter((r) => r.enabled), ...withMatch.filter((r) => !r.enabled)];
}

/** index of the first row that can actually run, or -1 */
export function firstRunnable(rows: PaletteRow[]): number {
  return rows.findIndex((r) => r.enabled);
}
