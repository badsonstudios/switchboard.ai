// The OS half of §5.8's focus-stealing policy (#756): a session that needs you
// may bring the WINDOW that hosts it to the front — the main window for a
// docked card, its own window for a popped-out one.
//
// THE POLICY IS NOT DECIDED HERE. It lives in the renderer, in one place
// (`lib/focus-policy` → `resolveFocusPolicy` → `attentionResponse` →
// `raisesHostWindow`), next to the in-app jump it already governs, so the two
// levels can never disagree about a session. By the time a request reaches
// this module the renderer has already said "this session's policy lets it
// take you there". What main adds is everything only main can know:
//
//   1. the master notification switch and quiet hours (DESIGN §5.8, decided
//      2026-10-18 for #756: a raise is a notification — it is aimed at a
//      person in the room, exactly like the beep and the taskbar flash that
//      `notifier.ts` already stops inside quiet hours);
//   2. which window it is, and whether a person could reach it at all
//      (`window-reach.ts`, #1277: never "raise" a window to an unplugged
//      display);
//   3. the no-activate e2e seam (#1332): the suite never takes the foreground;
//   4. whether that window already HAD the foreground when the session called;
//   5. the raise itself, with the technique Windows was measured to allow
//      (`raiseForAttention`), and an HONEST fallback: when the OS keeps the
//      foreground with another app, flash this window's taskbar button and
//      say so in the log. The lamp in the list carries the rest.
//
// Pure where it can be: `planAttentionRaise` is the whole gate as a table and
// `performAttentionRaise` takes its window and clock as arguments.
import type { Logger } from './log/logger';
import type { AttentionTechnique, AttentionWindow } from './window-activation';

/**
 * The feed kinds an attention raise can answer — the renderer's REVEAL_KINDS
 * (`lib/ladder`), which are what its jump reacts to. `crashed` is not one: the
 * notifier signals it, but no jump or raise follows it.
 */
export const RAISE_EVENT_KINDS: readonly string[] = ['needs-permission', 'needs-input', 'done'];

/** Every way a request ends. Logged verbatim and read by the e2e. */
export type RaiseOutcome =
  /** the window took the foreground */
  | 'raised'
  /** we asked (or knew better than to); the OS kept the foreground elsewhere.
   *  Flash + lamp carry it. */
  | 'refused'
  | 'notifications-off'
  | 'quiet-hours'
  /** the renderer named a popout main does not have (closed meanwhile) */
  | 'no-window'
  /** no attention event for that card landed recently: nothing to answer */
  | 'no-event'
  /** off every display, hidden, or not shown yet — see window-reach.ts */
  | 'unreachable'
  /** SWITCHBOARD_E2E_NO_ACTIVATE: requested, deliberately not performed */
  | 'no-activate'
  /** it was already the window in front when the session called */
  | 'already-front';

export interface RaiseFacts {
  /** the master switch (the 🔔 chip) */
  notificationsOn: boolean;
  inQuietHours: boolean;
  /** the target window exists */
  hasWindow: boolean;
  /** an attention event for this card landed recently (`FrontAtEvent`) */
  hadEvent: boolean;
  /** null when a person could reach it; otherwise why not (for the log) */
  unreachable: string | null;
  noActivate: boolean;
  /** it held the foreground when the session called */
  wasFront: boolean;
}

export type RaisePlan = { go: true } | { go: false; outcome: RaiseOutcome; detail?: string };

/**
 * THE GATE, in order. The order is the documented precedence, not tidiness:
 * the person's own "not now" (master switch, then the schedule) outranks every
 * fact about windows, so a quiet-hours request is reported as quiet hours even
 * when the window was also unreachable.
 *
 * `no-event` keeps this a REPLY: main raises a window only for a session it
 * itself saw call, never on the renderer's word alone.
 */
export function planAttentionRaise(f: RaiseFacts): RaisePlan {
  if (!f.notificationsOn) return { go: false, outcome: 'notifications-off' };
  if (f.inQuietHours) return { go: false, outcome: 'quiet-hours' };
  if (!f.hasWindow) return { go: false, outcome: 'no-window' };
  if (!f.hadEvent) return { go: false, outcome: 'no-event' };
  if (f.unreachable !== null) return { go: false, outcome: 'unreachable', detail: f.unreachable };
  if (f.noActivate) return { go: false, outcome: 'no-activate' };
  if (f.wasFront) return { go: false, outcome: 'already-front' };
  return { go: true };
}

/** What the OS window needs for the raise and its fallback. */
export interface RaiseTarget extends AttentionWindow {
  isFocused(): boolean;
  flashFrame(flag: boolean): void;
  once(event: 'focus', listener: () => void): unknown;
}

/** How long the OS gets to hand over the foreground before we call it refused.
 *  The probe saw a granted restore land inside 150 ms every time. */
export const RAISE_SETTLE_MS = 400;

/**
 * Raise, then check, then fall back.
 *
 * `isFocused()` after the attempt is trusted HERE and not in general: the
 * probe's lie (true with another process in front) came from refused
 * `focus()` calls, and `raiseForAttention` makes none on Windows when another
 * app is in front. Where it does — between our own windows (measured to work),
 * or on another OS — a lie reads as `raised`, and the one cost is a missing
 * flash, never a stolen keyboard.
 */
export async function performAttentionRaise(
  win: RaiseTarget,
  deps: {
    raise: (w: AttentionWindow) => AttentionTechnique;
    wait: (ms: number) => Promise<void>;
  }
): Promise<{ outcome: 'raised' | 'refused' | 'no-window' | 'no-activate'; technique: AttentionTechnique }> {
  const technique = deps.raise(win);
  // Backstops: the gate above already turns both of these away, but the raise
  // has its own answer and it must not be read as a refusal to flash for.
  if (technique === 'destroyed') return { outcome: 'no-window', technique };
  if (technique === 'quiet') return { outcome: 'no-activate', technique };
  if (technique !== 'none') {
    await deps.wait(RAISE_SETTLE_MS);
    if (win.isDestroyed()) return { outcome: 'no-window', technique };
    if (win.isFocused()) return { outcome: 'raised', technique };
  }
  // The OS said no (or, for `none`, was measured to). Degrade to the signal it
  // does allow, on THIS window — a popout has its own taskbar button, and the
  // notifier only flashes the main one. Cleared the moment the person arrives,
  // the notifier's own rule.
  try {
    win.flashFrame(true);
    win.once('focus', () => {
      if (!win.isDestroyed()) win.flashFrame(false);
    });
  } catch {
    // best-effort, like every other signal: never break the session flow
  }
  return { outcome: 'refused', technique };
}

/** One record per request, for the log and the non-packaged test counter. */
export interface RaiseRecord {
  outcome: RaiseOutcome;
  window: 'main' | 'popout';
  technique?: AttentionTechnique;
  detail?: string;
}

/** The log line for a record. Info, always: every outcome is a decision the
 *  owner may want to read back ("why did it not come forward?"). */
export function logRaise(log: Pick<Logger, 'info'>, r: RaiseRecord, cardId?: string): void {
  const why: Record<RaiseOutcome, string> = {
    raised: 'brought the window to the front',
    refused: 'the OS kept another app in front — flashing the taskbar; the lamp in the list carries it',
    'notifications-off': 'not raised: notifications are off',
    'quiet-hours': 'not raised: quiet hours',
    'no-window': 'not raised: that window is gone',
    'no-event': 'not raised: no recent attention event for that session',
    unreachable: 'not raised: nobody could see that window',
    'no-activate': 'not raised: test launch that must not take the foreground',
    'already-front': 'not raised: it was already in front',
  };
  log.info(`attention raise: ${why[r.outcome]}`, {
    outcome: r.outcome,
    window: r.window,
    ...(r.technique ? { technique: r.technique } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(cardId ? { cardId } : {}),
  });
}

/**
 * Which of our windows held the foreground when a card's latest attention
 * event landed — read at EVENT time, not at raise time, and that is
 * load-bearing.
 *
 * Between the two, the renderer does the in-app jump, and for a popped-out
 * card dockview can call the DOM `focus()` on that card's window as its group
 * becomes active (#1332 measured dockview doing so). With another app in
 * front that call is refused — and leaves Electron's `isFocused()` saying TRUE
 * anyway (measured, see `raiseForAttention`). Asked at raise time, a buried
 * popout would answer "I am already in front" and never be raised.
 *
 * KEYED BY CARD: a second session calling between the first one's event and
 * its raise request (which waits on the reveal and an IPC round trip) must not
 * overwrite what the first one's request reads. And its absence is the
 * `no-event` gate: main only raises for a session it saw call.
 *
 * Bounded by age, and pruned on write, so a workspace cannot accrete a record
 * per session it ever saw.
 *
 * KNOWN LIMIT: event time is only clean if no refused `focus()` came BEFORE
 * it, and the probe saw that lie persist. One path still produces one: a
 * popped-out card under `focus` whose raise is DECLINED (quiet hours, 🔔 off)
 * still gets dockview's DOM `focus()` from the in-app jump, refused. Until that
 * popout is really activated, its next event can read `already-front` (and the
 * notifier's flash guard is blinded the same way). Not fixed here: knowing the
 * truth needs the OS's foreground window, which Electron does not expose.
 */
export class FrontAtEvent {
  private readonly snaps = new Map<string, { windowId: number | null; at: number }>();

  constructor(private readonly maxAgeMs = 10_000) {}

  note(cardId: string, windowId: number | null, now: number): void {
    for (const [k, v] of this.snaps) if (now - v.at > this.maxAgeMs) this.snaps.delete(k);
    this.snaps.set(cardId, { windowId, at: now });
  }

  /** The window of ours in front when this card last called (null: none of
   *  ours), or undefined when it has not called recently. */
  frontFor(cardId: string, now: number): { windowId: number | null } | undefined {
    const s = this.snaps.get(cardId);
    if (!s || now - s.at > this.maxAgeMs) return undefined;
    return { windowId: s.windowId };
  }
}
