// The notification PREFERENCES, as both processes see them (#618).
//
// Same argument as `shared/sessions.ts` and `shared/transport.ts`: main owns
// the notifier — when it fires, what it says, whether the OS gets a toast — and
// that is main's business. What crosses is the settings record, and it crossed
// as two hand-written declarations that nothing compared: `NotificationPrefsState`
// in `main/workspace/store.ts` and `NotifPrefs` in `src/preload/index.ts`.
//
// They had already drifted once. The preload's copy was INLINE three times
// until P2-E14-05a added `sounds` and `speak`, and the inline copies did not
// all learn the new fields; naming it fixed those three against each other and
// left the real gap open — nothing at all compares the preload's name to main's,
// because an IPC boundary carries JSON and the compiler has no reason to look.
// `notifications:getPrefs` returns `workspace.getNotificationPrefs()` VERBATIM,
// so the two are the same object and the second declaration could only ever be
// right by luck.
//
// So: one declaration, imported by both sides. Unlike the session record there
// is no main-only half to extend with — the persisted record and the wire
// record are the same fields — so `main/workspace/store.ts` imports this rather
// than extending it, and there is nothing left to keep in step by hand.
//
// The VALUES live where they are read: `quietStart`/`quietEnd` are validated by
// `shared/quiet-hours.ts` (`isQuietTime`), and the defaults are main's
// (`store.ts`, `sanitizeNotifications`) because a workspace file outlives the
// code that wrote it and somebody has to decide what an unusable value means.

/**
 * What the user has said about notifications (§5.9).
 *
 * Every channel beyond the in-app one is OPT-IN and defaults OFF — E14's exit
 * criterion, and what makes each of them cost an existing user nothing.
 */
export interface NotificationPrefs {
  enabled: boolean;
  /** OS toast popups — opt-in, default OFF (Dan 2026-07-22) */
  osToasts?: boolean;
  /**
   * Per-session cues instead of the one plain beep (P2-E14-05a, §5.9).
   *
   * Opt-in, default OFF. With it off, the beep in `main/events/notifier.ts` is
   * exactly the sound the user has today.
   */
  sounds?: boolean;
  /** Spoken announcements (P2-E14-05a). Opt-in, default OFF, and of the two
   *  this is the one nobody should ever meet without asking for it. */
  speak?: boolean;
  /** quiet-hours window, `"HH:MM"` 24h local wall clock — `shared/quiet-hours.ts`
   *  owns what a usable pair is, and every writer refuses one it cannot read */
  quietStart?: string;
  quietEnd?: string;
}
