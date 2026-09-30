// WHAT A DISABLED COMMAND SAYS (#942) — the words, and nothing else.
//
// `lib/live-region.ts` is the channel, `components/LiveRegion.tsx` is the DOM and
// `lib/commands.ts` is what noticed: a chord that MATCHED a binding whose command
// is disabled right now used to produce nothing at all — no sound, no words, no
// visible change. §5.32's sixth rule applies verbatim, and it is the argument
// #581 already accepted for a refusal: silence is indistinguishable from a
// binding that has stopped working. A sighted user has the palette to check; a
// keyboard user with a screen reader had nothing, and #581 made things worse for
// them by giving the AVAILABLE cases a voice — which is a reason to expect an
// answer.
//
// NOTHING NEW IS WRITTEN HERE. Every command in the registry already carries a
// `disabledReasonKey`, and the palette already renders it beside the dimmed entry
// ("No session is focused", "Nothing is waiting on you"). The words existed; only
// a reader was missing.
//
// NOT `lib/session-voice.ts`, which speaks for §5.8's three chord families and
// the ladder. This speaks for the REGISTRY — any command, in any category, from
// either dispatch path — and it needs a command rather than a card.
//
// ── THREE DECISIONS, MADE DELIBERATELY (DESIGN §5.32) ───────────────────────
//
// 1. EVERY matched-but-unavailable command speaks, not a chosen subset. That is
//    #581's own argument applied consistently, and the alternative — an
//    allowlist per chord family — would be a second rule to keep in sync with a
//    registry that grows every milestone.
// 2. IT IS NOT GATED behind a double-press or a `scope === 'app'` filter. A chord
//    that matched is a real binding for a real command that is really disabled,
//    and saying why is information rather than noise. A "press it twice" rule
//    would itself be undiscoverable, which is the defect being fixed. The one
//    case that would genuinely spam — a held key auto-repeating — needs nothing
//    here: `dispatch` returns before any binding is matched when `e.repeat` is
//    set, and has since E9-01.
// 3. A KEYSTROKE NOTHING MATCHED STAYS SILENT. That is not a disabled command,
//    it is a key the app has no opinion about. `lib/commands`' `DispatchOutcome`
//    is where the two stopped sharing one `null`.
import i18next from 'i18next';
import { announce } from './live-region';
import type { Translate } from './session-voice';

/** The slice of a command this module reads. Structural on purpose: the sentence
 *  is a function of the reason key alone, so a test needs no registry and a
 *  contributed command (`extensibility/commands`) is handled by the same code as
 *  a seed one. */
export interface UnavailableCommand {
  id: string;
  disabledReasonKey?: string;
}

/**
 * Why this command could not run — the palette's own words for it.
 *
 * '' FOR A COMMAND WITH NO REASON KEY, and that is the honest answer rather than
 * a gap. `disabledReasonKey` is optional on `Command`, so a contribution can ship
 * an `enabled` predicate without one; inventing a sentence for it ("that command
 * is unavailable") would be this module guessing at somebody else's rule, and
 * §5.32's own note is that a live region which lies is worse than a silent one.
 * `announce('')` is already a no-op, so the empty string needs no second guard.
 */
export function unavailableSaid(t: Translate, cmd: UnavailableCommand): string {
  return cmd.disabledReasonKey ? t(cmd.disabledReasonKey) : '';
}

/** the singleton's `t`, narrowed — read at call time, which IS reading the
 *  current language. The same shape `lib/session-voice` uses, and for the same
 *  reason: this runs from a keydown handler, outside React's commit. */
const t: Translate = (key, vars) => String(i18next.t(key, vars));

/**
 * A chord matched this command and it is disabled: say why.
 *
 * Called from the app's keydown wiring rather than from inside the dispatcher,
 * which stays pure by construction — the same posture it already takes with
 * `onError`, and the same "the voice is wrapped around the command rather than
 * baked into it" shape #581 chose for the ladder.
 */
export function sayUnavailable(cmd: UnavailableCommand): void {
  announce(unavailableSaid(t, cmd));
}
