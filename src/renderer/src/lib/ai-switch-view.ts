// What the AI switch SAYS (E40 item 11, #1294) — the divider's words and the
// menu's rows, decided with no component in them so every branch can be pinned.
//
// THE HONESTY RULE (§5.5) is the reason this is one module. A first switch to an
// AI is a BRIEFED CONTINUATION — the new AI is handed a summary (#1295) — and is
// never called a resume; only going back to an AI the card has used before
// resumes, because only then does that AI pick up its own conversation. Every
// sentence about switching on screen comes from here, so the rule has one
// place to be wrong in.
import type { AiSwitchMark } from '../../../shared/ai-switch';
import type { SettingsSection } from './settings-sections';

import { AI_ICON_BASE } from '../../../shared/ais';
import { aiInk } from './ai-ink';

/**
 * The Settings tab "Manage AIs…" opens: the AIs tab (#1292). ONE constant, so
 * it is the one line that had to change when that tab landed.
 */
export const MANAGE_AIS_TAB: SettingsSection = 'ais';

/** When a switch happened, at the precision that helps: a time today, else a date and time. */
export function switchWhen(atMs: number, nowMs: number, locale?: string): string {
  const d = new Date(atMs);
  const now = new Date(nowMs);
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString(locale || undefined, { timeStyle: 'short' });
  return d.toLocaleString(locale || undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The divider's i18n key and values. Only what the mark records is said. */
export function dividerCopy(
  mark: AiSwitchMark,
  nowMs: number,
  locale?: string
): { key: string; vars: Record<string, string | number> } {
  const vars: Record<string, string | number> = {
    from: mark.from.name,
    to: mark.to.name,
    time: switchWhen(Date.parse(mark.at), nowMs, locale),
  };
  // #1295's half: claimed ONLY when the mark says a briefing was sent, and the
  // count only when it was recorded.
  if (mark.briefed && typeof mark.turnsSummarised === 'number') {
    // a long conversation is summarised from its recent end: "the last N"
    const key = mark.summaryPartial ? 'aiSwitch.dividerBriefedLastTurns' : 'aiSwitch.dividerBriefedTurns';
    return { key, vars: { ...vars, turns: mark.turnsSummarised } };
  }
  if (mark.briefed) return { key: 'aiSwitch.dividerBriefed', vars };
  // A SWITCH BACK — the one arrival that picked up the AI's own conversation,
  // so the one that may say so (§5.5's honesty rule)
  if (mark.resumed) return { key: 'aiSwitch.dividerResumed', vars };
  // a briefing was due and did not go: the AI has no context, and says so
  if (mark.briefingFailed) return { key: 'aiSwitch.dividerBriefingFailed', vars };
  // arrived, fresh, with nothing handed over — never a briefing it did not get
  if (mark.startedFresh) return { key: 'aiSwitch.dividerFresh', vars };
  // not started on yet, or a mark from before #1295 recorded what its arrival
  // was: nothing is claimed either way
  return { key: 'aiSwitch.divider', vars };
}

/** "See what it was told" is offered only for a briefing that was sent AND kept. */
export function briefingRefOf(mark: AiSwitchMark): string | undefined {
  return mark.briefed && typeof mark.briefingRef === 'string' && mark.briefingRef !== ''
    ? mark.briefingRef
    : undefined;
}

/**
 * The faint line above a briefed divider (screen 3's faded earlier turns, the
 * honest and cheap version): the other AI's turns are not drawn here — they
 * are that AI's conversation, and switching back shows them. Only for a
 * briefing with a count, which is the only mark that sits at the top of a
 * fresh conversation with something before it.
 */
export function earlierTurnsCopy(mark: AiSwitchMark): { key: string; vars: Record<string, string | number> } | undefined {
  if (!mark.briefed || typeof mark.turnsSummarised !== 'number' || mark.turnsSummarised <= 0) return undefined;
  // a partial summary's count is not all the turns there were: no number then
  if (mark.summaryPartial) return { key: 'aiSwitch.earlierTurnsMany', vars: { from: mark.from.name } };
  return { key: 'aiSwitch.earlierTurns', vars: { turns: mark.turnsSummarised, from: mark.from.name } };
}

/**
 * One AI as the catalog lists it (#1291's `AiListItem`), structurally — only
 * the fields the menu reads. `AiListItem` is assignable to it, which is what
 * lets a test hand the menu plain objects.
 */
export interface AiItemLike {
  kind: string;
  entry: { id: string; name: string; icon?: string };
  providerId?: string;
  registered: boolean;
  detection?: {
    installed: boolean | 'unknown';
    login: 'logged-in' | 'logged-out' | 'unknown';
    account?: string;
    plan?: string;
  };
}

/** One row of the switch menu. */
export interface AiMenuRow {
  /** stable key: the provider id, else the catalog id */
  key: string;
  /** what a pick switches to; absent for a row that cannot be picked */
  providerId?: string;
  name: string;
  /** the icon URL, from the renderer's own origin */
  icon?: string;
  /** the colour the icon is painted in (#1326); absent = `--text` */
  ink?: string;
  /** the AI this card is on now */
  current: boolean;
  /** can be picked: registered, and not known to be missing */
  selectable: boolean;
  /** drawn dimmed, with "set it up…" — not installed, or not available in this run */
  missing: boolean;
  /** the second line: an i18n key and its values */
  sub: { key: string; vars?: Record<string, string> };
}

/** The second line for one AI: its login state and account, or why it is missing. */
function subOf(item: AiItemLike, missing: boolean): AiMenuRow['sub'] {
  if (missing) {
    return { key: item.detection?.installed === false ? 'aiSwitch.notInstalled' : 'aiSwitch.notAvailable' };
  }
  const d = item.detection;
  // registered, but the probe did not find its program: still offered — the
  // start is the honest test — and said, so a failure that follows is no surprise
  if (d?.installed === false) return { key: 'aiSwitch.notFound' };
  if (!d || d.login === 'unknown') return { key: 'aiSwitch.loginUnknown' };
  if (d.login === 'logged-out') return { key: 'aiSwitch.loggedOut' };
  if (d.account && d.plan) return { key: 'aiSwitch.loggedInAsPlan', vars: { account: d.account, plan: d.plan } };
  if (d.account) return { key: 'aiSwitch.loggedInAs', vars: { account: d.account } };
  if (d.plan) return { key: 'aiSwitch.loggedInPlan', vars: { plan: d.plan } };
  return { key: 'aiSwitch.loggedIn' };
}

/**
 * The menu's rows: every AI the catalog lists, the current one marked.
 *
 * Selectable = registered in this run: there is a provider to start. Detection
 * does not veto it — a probe that did not find the program (or ran out of
 * time) is not proof the AI cannot start (Codex's adapter brings its own), so
 * such a row stays live and SAYS what the probe found. Missing = the catalog
 * knows the AI and this run has no provider for it: dimmed, "set it up…". A
 * registered provider the catalog has no entry for (a test fake) is listed too
 * — it is exactly as switchable as any other.
 *
 * The card's own AI is always listed and always marked, even if the catalog
 * does not name it, so the menu can never show a session on "nothing".
 */
export function aiMenuRows(
  items: readonly AiItemLike[],
  currentProviderId: string,
  currentName: string
): AiMenuRow[] {
  const rows: AiMenuRow[] = [];
  for (const item of items) {
    const providerId = item.providerId;
    const current = !!providerId && providerId === currentProviderId;
    const missing = !current && (!item.registered || !providerId);
    rows.push({
      key: providerId ?? `catalog:${item.entry.id}`,
      providerId: missing ? undefined : providerId,
      name: item.entry.name,
      icon: item.entry.icon ? AI_ICON_BASE + item.entry.icon : undefined,
      ...(item.kind === 'catalog' ? { ink: aiInk(item.entry.id) } : {}),
      current,
      selectable: !missing,
      missing,
      sub: subOf(item, missing),
    });
  }
  if (!rows.some((r) => r.current)) {
    rows.unshift({
      key: currentProviderId,
      providerId: currentProviderId,
      name: currentName || currentProviderId,
      current: true,
      selectable: true,
      missing: false,
      sub: { key: 'aiSwitch.loginUnknown' },
    });
  }
  // the AIs you can switch to first, the missing ones after — the mockup's order
  return [...rows.filter((r) => !r.missing), ...rows.filter((r) => r.missing)];
}

/**
 * What to do with main's answer to "switch this card to that AI" — the whole
 * decision, with no component in it (`afterSwitchAnswer`'s twin, #1127).
 *
 *  - `ask`    the session is busy and the user has not said to stop it: ask.
 *             Only for a request that did not already carry the yes.
 *  - `notice` refused; nothing about the session changed. Say why.
 *  - `close`  already on that AI: nothing to do.
 *  - `rearm`  main moved the card and ended its session: start the new one.
 */
export type SwitchAiNext =
  | { kind: 'ask'; busy: 'working' | 'waiting' }
  | { kind: 'notice'; key: string }
  | { kind: 'close' }
  | { kind: 'rearm' };

export function afterSwitchAiAnswer(
  answer: { ok: boolean; changed?: boolean; reason?: string; busy?: 'working' | 'waiting' } | null | undefined,
  stopFirst: boolean
): SwitchAiNext {
  if (!answer) return { kind: 'notice', key: 'aiSwitch.refusedFailed' };
  if (answer.ok) return answer.changed ? { kind: 'rearm' } : { kind: 'close' };
  if (answer.reason === 'busy' && answer.busy && !stopFirst) return { kind: 'ask', busy: answer.busy };
  if (answer.reason === 'unavailable') return { kind: 'notice', key: 'aiSwitch.refusedUnavailable' };
  return { kind: 'notice', key: 'aiSwitch.refusedFailed' };
}
