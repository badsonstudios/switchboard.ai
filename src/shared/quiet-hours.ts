// Quiet hours: the window, and how to read a clock against it (P2-E14-05b, §5.9).
//
// In `shared/` because BOTH processes need it and for different jobs: main
// evaluates it against the clock on every attention event (`events/rules.ts`),
// and the renderer validates what the user types before writing it
// (`QuietHoursDialog.tsx`). A second, looser copy of `isQuietTime` in the
// renderer would accept `99:99`, write it, and have main silently drop it —
// leaving a field that reverts with nothing on screen to say why. One
// predicate, one meaning.
//
// No clock of its own: `now` is always an argument. The single `new Date()`
// behind every caller lives in `main/index.ts`.

/**
 * A quiet-hours window: local wall-clock, `"HH:MM"` 24h, end exclusive.
 *
 * **Wall clock, not instants** (§5.9). "22:00–07:00" means those numbers on the
 * clock on the wall, whatever the calendar is doing underneath — so it needs no
 * timezone field, follows the machine if the user flies somewhere, and resolves
 * across a DST boundary by the same rule a person would use reading a clock:
 * the hour that repeats in autumn is quiet twice, and the hour that does not
 * exist in spring is simply never inside the window. That is the honest reading
 * of what the user typed, and it is the only one that needs no explanation in
 * the manual.
 *
 * `start === end` is not a 24-hour window — it is an empty one, and every
 * writer refuses the pair (`isUsableQuietWindow`), because a user cannot tell
 * those two apart by looking. Someone who wants silence all day turns
 * notifications off; there is a switch for exactly that.
 */
export interface QuietWindow {
  /** "HH:MM" 24h local */
  start: string;
  end: string;
}

/** The per-rule quiet-hours override (`Rule.quietHours`). */
export type QuietHoursMode = 'obey' | 'ignore';

export const QUIET_HOURS_MODES: readonly QuietHoursMode[] = ['obey', 'ignore'];

/** Minutes since local midnight, or null if it is not an `"HH:MM"` at all. */
function minutesOfDay(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
}

/**
 * Is this a wall-clock time a quiet window can use? `"22:00"`, not `"10pm"`.
 *
 * Every writer refuses what the evaluator cannot read: a `quietStart` of
 * `"night"` that survived into the workspace file would show as configured in
 * the dialog and silence nothing at all, which is the worst of the three
 * possible outcomes.
 */
export function isQuietTime(s: unknown): s is string {
  return typeof s === 'string' && minutesOfDay(s) !== null;
}

/**
 * Is this pair a window anything will ever be inside?
 *
 * The one gate every writer shares — the store's sanitizer, the IPC path and
 * the dialog — so "stored" and "means something" cannot drift apart.
 */
export function isUsableQuietWindow(start: unknown, end: unknown): boolean {
  return isQuietTime(start) && isQuietTime(end) && start !== end;
}

/** Is `now` (a LOCAL Date) inside the window? Windows crossing midnight work. */
export function inQuietWindow(win: QuietWindow | null | undefined, now: Date): boolean {
  if (!win || !isUsableQuietWindow(win.start, win.end)) return false;
  const start = minutesOfDay(win.start)!;
  const end = minutesOfDay(win.end)!;
  // `getHours`/`getMinutes` are local by definition — the wall clock, which is
  // exactly what was configured. Never `getUTCHours`.
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * What the notifications settings surface shows about quiet hours right now.
 *
 * The `heldCount` is here for one honest reason: a feature whose entire job is
 * to do nothing is a feature the user cannot tell is working. A number that
 * goes up proves it did.
 */
export interface QuietState {
  /** the configured window, or null */
  window: QuietWindow | null;
  /** is the window open at this instant? */
  active: boolean;
  /**
   * How many events are on the held list — **lifetime, capped at
   * `SUPPRESSED_CAP`**, not "during this window". Nothing clears it until
   * #483's digest ships a "mark as read"; the string that renders it says "so
   * far" for that reason.
   */
  heldCount: number;
}
