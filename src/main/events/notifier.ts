// Notifications (P1-E4-02, §5.9): the always-on signal — sound + taskbar flash
// on attention events — plus the global gate every channel sits behind (the
// master toggle and quiet hours). Prefs persist in the workspace store. Speed
// budget: hook -> feed -> here is milliseconds (S-06: Stop lands ~30ms after
// turn end).
//
// **What moved out (P2-E14-03).** The OS toast used to be an `if` right here.
// It is now an ACTION dispatched by the rules engine (`rules-engine.ts`), and
// the "not while the window is focused" part of it is a rule CONDITION rather
// than a special case — which is what lets the per-session "notify when done"
// checkbox be a rule instead of a second special case beside the first.
//
// The split that remains is deliberate: this class owns what happens for EVERY
// attention event no matter what (the beep, the flash, quiet hours, the master
// switch), the engine owns what happens only under conditions. A user who
// turns notifications off gets nothing at all — the gate is here, above the
// engine, so no rule can talk over it.
import { shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { FeedEvent } from './feed';

export interface NotificationPrefs {
  enabled: boolean;
  /** "HH:MM" 24h local; both set = quiet window (may span midnight) */
  quietStart?: string;
  quietEnd?: string;
  /** OS toast popups — OFF by default (Dan 2026-07-22: sound + Events
   *  panel are the signal; popups are opt-in via settings, E14 adds UI) */
  osToasts?: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = { enabled: true, osToasts: false };

/** Pure gate: is `now` inside the quiet window? Overnight ranges supported. */
export function inQuietHours(prefs: NotificationPrefs, now: Date): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const toMin = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
  };
  const start = toMin(prefs.quietStart);
  const end = toMin(prefs.quietEnd);
  if (start === null || end === null || start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Pure gate: should this event notify at all? */
export function shouldNotify(prefs: NotificationPrefs, e: FeedEvent, now: Date): boolean {
  if (!prefs.enabled) return false;
  if (inQuietHours(prefs, now)) return false;
  return e.kind === 'needs-input' || e.kind === 'needs-permission' || e.kind === 'done' || e.kind === 'crashed';
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
    }
  ) {}

  handle(e: FeedEvent): void {
    const prefs = this.opts.getPrefs();
    if (!shouldNotify(prefs, e, new Date())) return;
    try {
      // The signal model (Dan 2026-07-22): SOUND always + the Events panel;
      // taskbar flash when backgrounded. Everything else is a rule.
      shell.beep();
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
    // The rules LAST, and outside the try above: the unconditional signal is
    // cheap and local, the rules reach registered handlers that will one day
    // hit an audio device, a phone and a webhook, and neither half should be
    // able to cost the other. `RulesEngine.handle` swallows its own failures
    // for the same reason (P6).
    this.opts.rules?.handle(e);
  }
}
