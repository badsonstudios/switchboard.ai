// Notifications (P1-E4-02, §5.9): the always-on signal — sound + taskbar flash
// on attention events — plus the master toggle every channel sits behind.
// (Quiet hours used to sit here too; since P2-E14-05b they are a rule
// condition — see the note below.) Prefs persist in the workspace store. Speed
// budget: hook -> feed -> here is milliseconds (S-06: Stop lands ~30ms after
// turn end).
//
// **What moved out (P2-E14-03), and what CHANGED with it.** The OS toast used
// to be an `if` right here — `if (prefs.osToasts) show()`, with no condition on
// it at all. It is now an ACTION dispatched by the rules engine
// (`rules-engine.ts`) under rule CONDITIONS, which is what lets the per-session
// "notify when done" checkbox be a rule rather than a second special case.
//
// Note for anyone reading P2-E14-03's issue text: it describes the shipped
// behavior as "no OS toasts while the window is focused, crashes excepted".
// That was the DESIGN (§5.9), not the code — the focus test here only ever
// guarded `flashFrame`, never the toast. So for a user who had turned
// `osToasts` on, this item changed two things rather than porting them:
// `needs-input` / `needs-permission` stop toasting while the window is
// focused, and `done` stops toasting at all unless that session's box is
// ticked. Both are what §5.9 asked for; neither was true before.
//
// The split that remains is deliberate: this class owns what happens for EVERY
// attention event no matter what (the beep, the flash, the master switch), the
// engine owns what happens only under conditions. A user who turns
// notifications off gets nothing at all — that gate is here, above the engine,
// so no rule can talk over it.
//
// **What moved out (P2-E14-05b): quiet hours.** They used to sit right beside
// the master switch, above everything, and returning early from `handle` meant
// the rules engine was never even consulted between 22:00 and 07:00. That was
// the right shape while every channel was a person's ears — and the wrong one
// the moment `webhook` shipped, because a program watching the workspace
// overnight is precisely what a webhook is for. Quiet hours are now a rule
// CONDITION evaluated per action (`rules.ts` → `quietHolds`), and what stays
// here is only their effect on the two unconditional local signals below: the
// beep and the taskbar flash, both of which are aimed squarely at a person.
import { shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { FeedEvent, FeedKind } from './feed';
import { QuietWindow, inQuietWindow } from './rules';
// One record, one declaration (#618). This module had its OWN
// `interface NotificationPrefs` with the same six fields until then, and
// `main/index.ts` handed it `workspace.getNotificationPrefs()` verbatim —
// structurally compatible, so `tsc` never looked, which is exactly the drift
// class `shared/notifications.ts` exists to close. Re-exported because
// `notifier.test.ts` and the rules engine import the name from here.
//
// What the NOTIFIER does with two of those fields is worth saying, and says it
// here rather than on the shared declaration, because it is this module's
// behaviour and not part of the contract:
//
//   `sounds`  when it is on, the beep below steps aside for the `sound` rule
//             action, which fires on the same four events at every visibility
//             (`rules.ts` → `defaultRules`). One event has to make one noise.
//   `speak`   read only by the rules engine; the notifier has nothing
//             unconditional to say.
import type { NotificationPrefs } from '../../shared/notifications';

export type { NotificationPrefs };

/**
 * What the notifier assumes when nobody has asked it anything.
 *
 * NOT the store's defaults, and deliberately so: `sanitizeNotifications`
 * (`workspace/store.ts`) writes `{ enabled: true }` into an unreadable
 * workspace file, while this is the fallback for a notifier constructed with no
 * prefs at all — a test, or a boot that has not read the workspace yet. Both
 * say "notifications on, popups off"; this one spells the second half out
 * because `osToasts` being absent has to mean OFF at the only place that reads
 * it as a boolean.
 */
export const DEFAULT_PREFS: NotificationPrefs = { enabled: true, osToasts: false };

/**
 * The prefs' quiet window as the rules engine wants it, or null.
 *
 * Shape only — the CONTENT is validated where it is used and where it is
 * written: `inQuietWindow` refuses anything that is not two parseable, unequal
 * times, and the store's sanitizer refuses to persist such a pair in the first
 * place (`isUsableQuietWindow`). One predicate, applied at both ends, rather
 * than a third copy of it here.
 */
export function quietWindowOf(prefs: NotificationPrefs): QuietWindow | null {
  if (!prefs.quietStart || !prefs.quietEnd) return null;
  return { start: prefs.quietStart, end: prefs.quietEnd };
}

/** Pure gate: is `now` inside the quiet window? Overnight ranges supported. */
export function inQuietHours(prefs: NotificationPrefs, now: Date): boolean {
  return inQuietWindow(quietWindowOf(prefs), now);
}

/** The four kinds worth a signal at all. `ready` is a transition, not a summons. */
function isAttention(kind: FeedKind): boolean {
  return kind === 'needs-input' || kind === 'needs-permission' || kind === 'done' || kind === 'crashed';
}

/**
 * Pure gate: should the UNCONDITIONAL local signal happen — the beep and the
 * taskbar flash?
 *
 * Both are aimed at a person in the room, so both still stop dead inside quiet
 * hours. What changed in P2-E14-05b is what this function no longer decides:
 * it is not the gate on the rules engine any more (`shouldConsultRules`).
 */
export function shouldNotify(prefs: NotificationPrefs, e: FeedEvent, now: Date): boolean {
  if (!prefs.enabled) return false;
  if (inQuietHours(prefs, now)) return false;
  return isAttention(e.kind);
}

/**
 * Pure gate: should the rules engine see this event at all?
 *
 * The master switch and the kind, and deliberately NOT the clock: quiet hours
 * are decided per action inside the engine now, because a webhook has no ears
 * (`rules.ts` → `quietHolds`), and because an event the engine never sees is an
 * event that can never reach the missed-events digest (#483).
 *
 * The master switch still cuts everything, rules included — it is a person
 * saying "not now, at all", not a schedule, and §5.9 promises exactly that.
 */
export function shouldConsultRules(prefs: NotificationPrefs, e: FeedEvent): boolean {
  return prefs.enabled && isAttention(e.kind);
}

export class Notifier {
  private flashPending = false;

  constructor(
    private readonly opts: {
      getWindow: () => BrowserWindow | null;
      getPrefs: () => NotificationPrefs;
      /** the rules engine — every conditional channel (toast today; sound,
       *  TTS, push, webhook as E14 lands them) goes through it */
      rules?: { handle: (e: FeedEvent) => void };
      /** the app's ONE clock (P2-E14-05b) — the same function the engine gets,
       *  so the beep and the rules can never disagree about what time it is */
      now?: () => Date;
    }
  ) {}

  handle(e: FeedEvent): void {
    const prefs = this.opts.getPrefs();
    if (!shouldConsultRules(prefs, e)) return;
    const now = (this.opts.now ?? (() => new Date()))();
    // The local signal, under quiet hours. The rules run either way, below.
    if (shouldNotify(prefs, e, now)) this.localSignal(prefs);
    // The rules LAST, and outside the try above: the unconditional signal is
    // cheap and local, the rules reach registered handlers that will one day
    // hit an audio device, a phone and a webhook, and neither half should be
    // able to cost the other. `RulesEngine.handle` swallows its own failures
    // for the same reason (P6).
    this.opts.rules?.handle(e);
  }

  private localSignal(prefs: NotificationPrefs): void {
    try {
      // The signal model (Dan 2026-07-22): SOUND always + the Events panel;
      // taskbar flash when backgrounded. Everything else is a rule.
      //
      // P2-E14-05a: with per-session cues switched on, the cue IS this sound —
      // a distinguishable one that says which card moved — so the beep steps
      // aside rather than doubling it. It is not merely muted: if the cue
      // cannot be handed to a renderer, `SoundActions` beeps instead, so the
      // "an attention event always makes a noise" promise survives an audio
      // channel that is broken or a window that is gone.
      if (!prefs.sounds) shell.beep();
      const win = this.opts.getWindow();
      if (win && !win.isDestroyed() && !win.isFocused() && !this.flashPending) {
        this.flashPending = true;
        win.flashFrame(true);
        win.once('focus', () => {
          this.flashPending = false;
          if (!win.isDestroyed()) win.flashFrame(false);
        });
      }
    } catch {
      // notifying is best-effort; never let it break the session flow
    }
  }
}
