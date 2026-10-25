// The four autonomy profiles (§5.9) — the ORDER they cycle in, and the ONE
// place the hover copy that explains them is assembled (#534).
//
// WHY THIS FILE EXISTS
// --------------------
// The mode appears in two places — the shield button under the prompt box
// (this session's mode, and the ONE control that sets it) and the read-only
// badge in the card header — and until #534 neither said what a mode DOES.
// The names alone do not carry the load-bearing distinction, and Dan had to ask
// what separated auto-edit from full-auto. Two surfaces means two chances for
// two different answers, so the copy lives in `en.json` under `autonomy.desc.*`
// and every surface composes its tooltip through `autonomyTooltip` below.
//
// THERE WERE THREE until #1434. A title-bar chip set the mode NEW sessions
// started at, beside the per-session shield, and Dan found two controls for
// one idea confusing — his call was to keep only the per-session one. New
// sessions start at `DEFAULT_AUTONOMY` now; a dispatch role template still
// brings its own. The `autonomy` key that chip wrote to the ui blob is left
// where it is, read by nothing (no migration).
//
// "ASK" IS NOT "ASK ABOUT EVERYTHING" (#1434). Ask is the CLI's `default`
// permission mode (`main/providers/claude-modes.ts`) — and that honours
// the allow rules in the user's Claude Code settings before Switchboard is
// consulted at all. That is correct (host-don't-reimplement) and stays; what
// was wrong was copy promising every tool call would come to you. The copy
// says "everything your settings don't already allow" now. The other thing
// that silences an ask session is OURS: "Allow all (this session)", which the
// chip now says out loud (`autonomyLabel` / `allowAllTooltip` below).
//
// THE COPY IS A CLAIM ABOUT THE CLI, SO IT WAS MEASURED, NOT GUESSED
// ------------------------------------------------------------------
// Each profile maps to a `--permission-mode` value in
// `src/main/providers/claude-modes.ts` (`ask` = `default`, named explicitly
// since #587 — it used to be no flag at all). What each of those modes actually does was read off the shipped
// contract rather than assumed — `claude --help` on PATH (2.1.233), the
// settings schema in the unpacked VS Code extension, and Anthropic's
// permission-mode reference. Two things came out of that worth writing down,
// because the next person to "tidy" this copy will otherwise re-introduce them:
//
//   • `full-auto` is `bypassPermissions`, and the docs say in terms that
//     `--dangerously-skip-permissions` IS that mode. It is not a softer,
//     sandboxed cousin of it. What survives it is small and specific: `deny`
//     rules (which "block in every mode, including bypassPermissions"),
//     explicit `ask` rules, tools that need a person (AskUserQuestion), and
//     `rm`/`rmdir` aimed at a critical path. `allow` rules stop meaning
//     anything. The copy says so.
//   • `auto-edit` is `acceptEdits`, which auto-approves more than file edits:
//     `mkdir`, `touch`, `mv`, `cp`, `rm`, `rmdir` and `sed` inside the working
//     directory go through too. What keeps "shell commands still come to you"
//     honest at this profile is OURS — the PreToolUse hold policy in
//     `main/hooks/hook-listener.ts` gates every shell call at `auto-edit`, in
//     both transports, because the hooks settings file is written for every
//     session regardless of transport. So the copy may make that promise, but
//     it is a promise about SWITCHBOARD, not about the CLI, and the manual page
//     says so. (Which also means we ask about a `mkdir` the bare CLI would have
//     waved through. Noisier, and the safe direction.)
import i18next, { type TFunction } from 'i18next';
import { AUTONOMY_MODES, isAutonomyMode, type AutonomyMode } from '../../../shared/sessions';

/**
 * The four profiles.
 *
 * DERIVED, not declared (#618). The same union was hand-written nine times —
 * here, main's live record, the card's persisted record, the spawn option,
 * `SessionManager.create`'s options, the `sessions:create` argument in main and
 * again in the preload, the result the preload re-publishes, and
 * `AUTONOMY_PERMISSION_MODE`'s keys — with two runtime copies of the list
 * besides: `sessions:setAutonomy`'s inline validator array and `AUTONOMIES`
 * just below. `shared/sessions.ts` declares all of it once. The local NAME
 * stays because every renderer call site says `Autonomy`, and this file is
 * still where the renderer's half of the feature lives.
 */
export type Autonomy = AutonomyMode;

/**
 * The cycle order for the chips and the palette.
 *
 * Least to most autonomous, with `plan` second because it is the one mode that
 * grants LESS than the default rather than more — a user walking the cycle
 * meets "safe" and "safer" before anything starts running on its own. That
 * order is now recorded with the values in `shared/sessions.ts`, so the type
 * cannot outgrow the list the chip walks.
 */
export const AUTONOMIES: readonly Autonomy[] = AUTONOMY_MODES;

/** What a session runs at when nobody has said otherwise. */
export const DEFAULT_AUTONOMY: Autonomy = 'ask';

/** Is this stored/IPC value one we still recognise? A workspace blob outlives
 *  the code that wrote it, so an unknown value must fall back rather than be
 *  rendered as a missing translation key. The predicate is shared with main,
 *  which needs the same answer about untrusted input (§5.29). */
export const isAutonomy = isAutonomyMode;

/** The next mode for a chip click — wrapping, and tolerant of a value we do
 *  not recognise (which starts the walk from the default). */
export function nextAutonomy(cur: string | undefined): Autonomy {
  const i = isAutonomy(cur) ? AUTONOMIES.indexOf(cur) : AUTONOMIES.indexOf(DEFAULT_AUTONOMY);
  return AUTONOMIES[(i + 1) % AUTONOMIES.length];
}

/**
 * Which control is being hovered — the second half of the tooltip.
 *
 * The description of a mode is the same everywhere; what differs is WHAT THIS
 * CONTROL DOES WITH IT. Two scopes, one per surface (a third, `workspace`, was
 * the title-bar chip #1434 removed):
 *
 *   session    the shield button under the prompt box — this session, next start
 *   badge      the card header's read-only marker — states, does not set
 */
export type AutonomyScope = 'session' | 'badge';

/**
 * The hover text for one mode on one control.
 *
 * Two paragraphs separated by a blank line, because a native `title` honours
 * newlines and a wall of one paragraph is what the issue was complaining
 * about. `title` is also the element's accessible DESCRIPTION once its name
 * comes from its own content, which is how every other explanatory hover in
 * this app reaches a screen reader (see `Chip` in `components/chrome.tsx`, and
 * the gap it records for sighted keyboard-only users — unchanged here, because
 * a new tooltip mechanism on these controls is not this item's business).
 */
export function autonomyTooltip(
  t: TFunction,
  mode: string | undefined,
  scope: AutonomyScope,
  /**
   * Whether the control's AI is Claude (#1316). The mode's own sentence is
   * AI-neutral; what Claude Code does with it (its `acceptEdits`, its
   * `bypassPermissions`, no switching mid-flight) is a claim about one CLI,
   * so it is added only when that is the CLI. Absent: not known, so not said.
   */
  claude = false
): string {
  const m = isAutonomy(mode) ? mode : DEFAULT_AUTONOMY;
  const what = t(`autonomy.desc.${m}`);
  const whatClaude = claude && CLAUDE_NOTES.has(m) ? ` ${t(`autonomy.claude.${m}`)}` : '';
  const how = t(`autonomy.scope.${scope}`);
  const howClaude = claude && scope === 'session' ? ` ${t('autonomy.claude.session')}` : '';
  return `${what}${whatClaude}\n\n${how}${howClaude}`;
}

/** The modes whose Claude Code behaviour has its own sentence. Every one since
 *  #1434: `ask`'s is that the user's allow rules still apply, which is the
 *  claim its old copy ("every tool call comes to you first") got wrong. */
const CLAUDE_NOTES: ReadonlySet<Autonomy> = new Set<Autonomy>(['ask', 'plan', 'auto-edit', 'full-auto']);

/** The blank line between a tooltip's paragraphs (a native `title` honours it). */
export const PARAGRAPH = String.fromCharCode(10, 10);

/**
 * What the mode chip and the header badge SAY (#1434).
 *
 * `allowAll` is "Allow all (this session)" in force: main answers every gated
 * call Allow, with no hold and no sound, until the session restarts. A chip
 * that went on reading "🛡 ask" over that was the bug, so the label carries
 * it whatever the mode: "🛡 ask · allow all". Full-auto already asks nothing,
 * so it reads as itself.
 */
export function autonomyLabel(t: TFunction, mode: string | undefined, allowAll: boolean): string {
  const m = isAutonomy(mode) ? mode : DEFAULT_AUTONOMY;
  const plain = t(`autonomy.${m}`);
  return allowAll && m !== 'full-auto' ? t('autonomy.allowAll.label', { mode: plain }) : plain;
}

/**
 * The first paragraph of an allow-all session's chip tooltip (#1434): since
 * when, that it lasts until restart, and how to stop it — plus how many files
 * are also always allowed (issue 974's middle rung), when there are any.
 *
 * `since` absent (a preload older than the field) drops the time rather than
 * inventing one.
 */
export function allowAllTooltip(
  t: TFunction,
  grants: { allowAllSince?: number; files: readonly string[] },
  /** how this surface stops it: the chip offers the button, the badge points at the chip */
  scope: AutonomyScope
): string {
  const since =
    grants.allowAllSince !== undefined
      ? t('autonomy.allowAll.since', { time: clockTime(grants.allowAllSince) })
      : t('autonomy.allowAll.sinceUnknown');
  const files = grants.files.length > 0 ? ` ${t('autonomy.allowAll.files', { count: grants.files.length })}` : '';
  const how = t(scope === 'session' ? 'autonomy.allowAll.howSession' : 'autonomy.allowAll.howBadge');
  return `${since} ${how}${files}`;
}

/**
 * A short clock time in the APP's language, like the find bar's hits
 * (`find-providers.ts`) — falling back to the platform's when the tag is one
 * `Intl` will not take (the pseudo-locale is exactly that).
 */
function clockTime(ms: number): string {
  const d = new Date(ms);
  try {
    return d.toLocaleTimeString(i18next.language || undefined, { timeStyle: 'short' });
  } catch {
    return d.toLocaleTimeString(undefined, { timeStyle: 'short' });
  }
}
