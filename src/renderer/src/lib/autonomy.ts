// The four autonomy profiles (§5.9) — the ORDER they cycle in, and the ONE
// place the hover copy that explains them is assembled (#534).
//
// WHY THIS FILE EXISTS
// --------------------
// The mode appears on three controls — the title-bar chip (the mode NEW
// sessions start at), the shield button under the prompt box (this session's
// mode) and the read-only badge in the card header — and until #534 none of
// them said what a mode DOES. The names alone do not carry the load-bearing
// distinction, and Dan had to ask what separated auto-edit from full-auto.
// Three controls means three chances for three different answers, so the copy
// lives in `en.json` under `autonomy.desc.*` and every surface composes its
// tooltip through `autonomyTooltip` below.
//
// THE COPY IS A CLAIM ABOUT THE CLI, SO IT WAS MEASURED, NOT GUESSED
// ------------------------------------------------------------------
// Each profile maps to a `--permission-mode` value in
// `src/main/providers/claude.ts` (`ask` = no flag at all, i.e. the CLI's own
// default). What each of those modes actually does was read off the shipped
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
import type { TFunction } from 'i18next';
import { AUTONOMY_MODES, isAutonomyMode, type AutonomyMode } from '../../../shared/sessions';

/**
 * The four profiles.
 *
 * DERIVED, not declared (#618). The same union was hand-written nine times —
 * here, main's live record, the card's persisted record, the spawn option, the
 * `sessions:create` argument in main and again in the preload, the result the
 * preload re-publishes, and `AUTONOMY_PERMISSION_MODE`'s keys — with a tenth
 * copy as a runtime array in `sessions:setAutonomy`'s validator.
 * `shared/sessions.ts` declares it once. The local NAME stays because every
 * renderer call site says `Autonomy`, and this file is still where the
 * renderer's half of the feature lives.
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
 * CONTROL DOES WITH IT, and that is the question a user actually has in front
 * of the title bar ("will this change the session I am looking at?"). Three
 * scopes, one per surface:
 *
 *   workspace  the title-bar chip — the mode NEW sessions start at
 *   session    the shield button under the prompt box — this session, next start
 *   badge      the card header's read-only marker — states, does not set
 */
export type AutonomyScope = 'workspace' | 'session' | 'badge';

/**
 * The hover text for one mode on one control.
 *
 * Two paragraphs separated by a blank line, because a native `title` honours
 * newlines and a wall of one paragraph is what the issue was complaining
 * about. `title` is also the element's accessible DESCRIPTION once its name
 * comes from its own content, which is how every other explanatory hover in
 * this app reaches a screen reader (see `Chip` in `components/chrome.tsx`, and
 * the gap it records for sighted keyboard-only users — unchanged here, because
 * a new tooltip mechanism on three controls is not this item's business).
 */
export function autonomyTooltip(t: TFunction, mode: string | undefined, scope: AutonomyScope): string {
  const m = isAutonomy(mode) ? mode : DEFAULT_AUTONOMY;
  return `${t(`autonomy.desc.${m}`)}\n\n${t(`autonomy.scope.${scope}`)}`;
}
