// The last inch of an OS toast (#1338): the one place main calls
// `Notification.show()`.
//
// WHY A SEAM. The e2e suite runs on the machine its owner is working at, and
// with `SWITCHBOARD_E2E_NO_ACTIVATE=1` (#1332) the test app is genuinely
// "away" — no window of its own is ever focused — so the WHEN_AWAY toast rules
// fire for real and a full run piled silent Windows notifications into the
// corner of the main screen. `SWITCHBOARD_MUTE_TOASTS=1` is the toast twin of
// `SWITCHBOARD_MUTE_AUDIO` (P2-E14-05a), and it is built the same way:
//
//   - EVERYTHING BUT THE SHOW STILL HAPPENS. The rule fires, the toast object
//     is built with its buttons, tracked for withdrawal, and the
//     "os toast rule fired" line is written — so `rules.spec.ts`,
//     `permission-toast.spec.ts` and the notification specs keep proving the
//     whole chain, and only the pixels on the desktop are missing.
//   - SET BY THE FIXTURE ON EVERY LAUNCH, before `opts.env`, so a spec that
//     genuinely needs a real toast passes `SWITCHBOARD_MUTE_TOASTS: ''`.
//   - NON-PACKAGED BUILDS ONLY, the rule the audio mute and the other e2e
//     seams follow: a stray variable in a user's environment must never be
//     able to silence the shipped app's notifications.

/** The env var that mutes the show. One definition, named once. */
export const MUTE_TOASTS_ENV = 'SWITCHBOARD_MUTE_TOASTS';

/** Non-empty and not packaged — the same reading as `SWITCHBOARD_MUTE_AUDIO`. */
export function toastsMuted(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  return !packaged && !!env[MUTE_TOASTS_ENV];
}

/** Electron's `Notification`, reduced to the one call this makes. */
export interface ShowableToast {
  show(): void;
}

/**
 * Put a built toast on the desktop, unless muted. Answers whether it was
 * MUTED, so the caller's "os toast rule fired" line logs the decision this
 * made rather than re-deriving it — one answer, one place.
 */
export function showOsToast(toast: ShowableToast, deps: { muted: boolean }): { muted: boolean } {
  if (deps.muted) return { muted: true };
  toast.show();
  return { muted: false };
}
