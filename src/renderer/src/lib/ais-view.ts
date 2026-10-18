// The AIs tab's sorting and wording rules, as pure functions (E40 item 09,
// #1292), so what goes under "Found" and what a row says are unit tests rather
// than a screenshot.
//
// THE RULES:
// - **Found on this computer** = every AI Switchboard can start a session on
//   (registered), plus every other AI whose detection says it is installed.
//   A registered AI stays in Found even when its program has gone missing: it
//   is still the one new sessions may start on, and the row says what is wrong.
// - **Not found** = the rest. A row whose detection has not come back yet says
//   "checking…", never "not found" (detection runs after first paint, so the
//   tab can be opened before it finishes). An `unknown` answer says it could
//   not tell, with the reason.
// - **The default picker** lists registered AIs only: an AI with no provider
//   cannot start a session, so offering it would be a choice that falls back.
import {
  AI_ICON_BASE,
  type AiListItem,
  type AisSnapshot,
  type CustomAiDraft,
  type DetectionResult,
  type InstallHint,
} from '../../../shared/ais';
import { aiInk } from './ai-ink';

export interface AiRowView {
  /** the list item's id: the catalog id, `custom:<slug>`, or the provider id */
  key: string;
  kind: AiListItem['kind'];
  name: string;
  maker?: string;
  description?: string;
  /** `<img src>`, relative to the page (the renderer's own origin) */
  iconSrc?: string;
  /** the colour the icon is painted in (#1326); absent = `--text` */
  ink?: string;
  /** set only when a session can start on it */
  providerId?: string;
  isDefault: boolean;
  detection?: DetectionResult;
  install?: InstallHint;
  runsLocalModels: boolean;
}

/** Where a row's program stands, in one word. */
export type Presence = 'checking' | 'installed' | 'missing' | 'unknown';

export function presenceOf(d: DetectionResult | undefined): Presence {
  if (!d) return 'checking';
  if (d.installed === true) return 'installed';
  if (d.installed === false) return 'missing';
  return 'unknown';
}

export function rowOf(item: AiListItem, defaultId: string): AiRowView {
  const providerId = item.registered ? item.providerId : undefined;
  const base = {
    key: item.entry.id,
    kind: item.kind,
    name: item.entry.name,
    ...(providerId ? { providerId } : {}),
    isDefault: !!providerId && providerId === defaultId,
    ...(item.detection ? { detection: item.detection } : {}),
  };
  if (item.kind === 'catalog') {
    const e = item.entry;
    return {
      ...base,
      maker: e.maker,
      description: e.description,
      ...(e.icon ? { iconSrc: AI_ICON_BASE + e.icon } : {}),
      ink: aiInk(e.id),
      install: e.install,
      runsLocalModels: e.runsLocalModels,
    };
  }
  return { ...base, runsLocalModels: false };
}

export interface AisSplit {
  found: AiRowView[];
  notFound: AiRowView[];
  /** what the "New sessions start on" picker offers */
  choices: Array<{ id: string; name: string }>;
}

export function splitAis(s: AisSnapshot): AisSplit {
  const rows = s.items.map((i) => rowOf(i, s.default.id));
  const found = rows.filter((r) => !!r.providerId || presenceOf(r.detection) === 'installed');
  const notFound = rows.filter((r) => !found.includes(r));
  const seen = new Set<string>();
  const choices: Array<{ id: string; name: string }> = [];
  for (const r of rows) {
    if (!r.providerId || seen.has(r.providerId)) continue;
    seen.add(r.providerId);
    choices.push({ id: r.providerId, name: r.name });
  }
  // The default first in Found, so the row the picker names is the one on top.
  found.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return { found, notFound, choices };
}

/** The name to show for a provider id, falling back to the id itself. */
export function aiName(s: AisSnapshot, providerId: string | undefined): string {
  if (!providerId) return '';
  const hit = s.items.find((i) => i.providerId === providerId || i.entry.id === providerId);
  return hit ? hit.entry.name : providerId;
}

/** The catalog rows the Add-an-AI list shows, after its search and filter. */
export function catalogRows(
  s: AisSnapshot,
  opts: { query?: string; localOnly?: boolean } = {}
): AiRowView[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  return s.items
    .filter((i) => i.kind === 'catalog')
    .map((i) => rowOf(i, s.default.id))
    .filter((r) => !opts.localOnly || r.runsLocalModels)
    .filter(
      (r) =>
        !q ||
        r.name.toLowerCase().includes(q) ||
        (r.maker ?? '').toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q)
    );
}

/**
 * The Arguments box, as a list. Split on whitespace: an argument may not hold
 * a space anyway (main refuses it — the `cmd /c` quote-stripping case), so
 * "put each part in its own argument" is exactly what a space does here.
 */
export function splitArgs(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((a) => a !== '');
}

/** What the "Something else" form sends. */
export function draftOf(form: { name: string; command: string; args: string }): CustomAiDraft {
  return { name: form.name.trim(), command: form.command.trim(), args: splitArgs(form.args) };
}

/**
 * Two drafts start the same program: Add is enabled only for the one Test
 * passed. The name is not part of it; renaming does not change what runs.
 */
export function sameProgram(a: CustomAiDraft | null, b: CustomAiDraft): boolean {
  if (!a) return false;
  const args = (d: CustomAiDraft): string => JSON.stringify(d.args ?? []);
  return a.command === b.command && args(a) === args(b);
}
