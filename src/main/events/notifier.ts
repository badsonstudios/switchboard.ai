// Notifications v1 (P1-E4-02, §5.9): OS toast + window flash + sound on
// attention events. Global toggle + quiet hours; prefs persist in the
// workspace store. Speed budget: hook -> feed -> here is milliseconds
// (S-06: Stop lands ~30ms after turn end).
import { Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { FeedEvent } from './feed';

export interface NotificationPrefs {
  enabled: boolean;
  /** "HH:MM" 24h local; both set = quiet window (may span midnight) */
  quietStart?: string;
  quietEnd?: string;
}

export const DEFAULT_PREFS: NotificationPrefs = { enabled: true };

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
      titleFor: (sessionId: string) => string;
      bodyFor: (e: FeedEvent) => string;
    }
  ) {}

  handle(e: FeedEvent): void {
    if (!shouldNotify(this.opts.getPrefs(), e, new Date())) return;
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: this.opts.titleFor(e.sessionId),
          body: this.opts.bodyFor(e),
          silent: false, // OS toast sound = the sound cue
        }).show();
      }
      const win = this.opts.getWindow();
      if (win && !win.isDestroyed() && !win.isFocused() && !this.flashPending) {
        this.flashPending = true;
        win.flashFrame(true);
        win.once('focus', () => {
          this.flashPending = false;
          if (!win.isDestroyed()) win.flashFrame(false);
        });
      }
      shell.beep();
    } catch {
      // notifying is best-effort; never let it break the session flow
    }
  }
}
