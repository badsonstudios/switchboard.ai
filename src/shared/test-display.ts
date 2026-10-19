// Which screen this project's OWN automated tests open their windows on (#479,
// #1331). Pure, and shared by exactly two readers that must never disagree:
//
//   - the e2e fixture (`e2e/fixtures/app.ts`), which resolves the saved value
//     against the display list of the app it just launched and moves the window;
//   - Settings → Advanced → Testing, which writes the value and has to say
//     truthfully which screen it now means — including "that screen is not
//     attached, so the tests run on the primary".
//
// The rule lived in the fixture alone until #1331. Copying it into the app would
// have been two definitions of "the screen to the right" one edit apart, and the
// failure that produces is the worst kind for a setting: Settings ticks one
// screen while the suite opens on another.
//
// THE VALUE FORMS, all resolved by `resolveTestDisplay`:
//   - `1`..`N`   — monitor 1 is always the PRIMARY; 2..N the rest in the order
//                  Electron reports them (which is undocumented — see the
//                  fixture's header for why that is still safe).
//   - `left` / `right` / `above` / `below` — the nearest screen whose centre
//                  lies that way from the primary's. Survives a different
//                  monitor detaching; an index does not.
//   - `id:<n>`   — Electron's `display.id`. On Windows it survives a reboot
//                  while the screen stays on the same connector; re-cabling
//                  or a driver change can renumber it, and an id that no
//                  longer answers falls back to the primary like the rest.
//                  What Settings writes when no direction word is unambiguous.
//
// Anything that cannot be resolved means "do nothing" — the primary. A
// developer-comfort switch must never be why a run goes red.

/** The env var that turns the move on. One definition, named once. */
export const E2E_MONITOR_ENV = 'SWITCHBOARD_E2E_MONITOR';

/** The per-machine file consulted when the env var is absent (in `~`). */
export const E2E_SETTINGS_FILE = '.switchboard-e2e.env';

/**
 * The file's second key (#1332, surfaced in Settings by #1335): launch the
 * suite's windows without taking the OS foreground. Read by the fixture and by
 * Settings → Advanced → Testing, through `noActivateOn`, so the checkbox and
 * the suite can never disagree about what a hand-written value means.
 */
export const E2E_NO_ACTIVATE_ENV = 'SWITCHBOARD_E2E_NO_ACTIVATE';

/** What Settings writes when the box is ticked; unticked removes the line. */
export const E2E_NO_ACTIVATE_ON = '1';

/** `1` / `true` / `on` / `yes`, any case, is on. Empty, absent or anything else is off. */
export function noActivateOn(value: string | undefined | null): boolean {
  const v = value?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** A rectangle in Electron's screen coordinates. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One display, reduced to what the resolver needs. */
export interface DisplayInfo {
  id: number;
  workArea: Box;
}

/**
 * Pull one key out of a `KEY=VALUE` file.
 *
 * Deliberately a six-line dotenv: trims, skips blanks and `#` lines, strips one
 * layer of matching quotes, last occurrence wins. Anything fancier is a
 * dependency for a file with one key in it.
 */
export function readSettingsKey(contents: string, key: string): string | undefined {
  let found: string | undefined;
  for (const raw of contents.split(/\r?\n/)) {
    if (!isKeyLine(raw, key)) continue;
    const line = raw.trim();
    let value = line.slice(line.indexOf('=') + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
}

/** Is this one line an assignment to `key`, by `readSettingsKey`'s own reading? */
function isKeyLine(raw: string, key: string): boolean {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return false;
  const eq = line.indexOf('=');
  return eq >= 0 && line.slice(0, eq).trim() === key;
}

/**
 * The same file with `key` set to `value` — or removed, for `null` — and
 * EVERY OTHER LINE KEPT AS IT WAS: comments, other keys, blank lines, the line
 * ending the file already uses, and whether it ends in one.
 *
 * Several assignments to the key collapse into one, in the place of the first:
 * `readSettingsKey` takes the last, so leaving a stale earlier one behind would
 * be harmless today and a trap for whoever reads the file by eye.
 */
export function writeSettingsKey(contents: string, key: string, value: string | null): string {
  const eol = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents === '' ? [] : contents.split(/\r?\n/);
  // a file that ends in a newline splits into a trailing '' — keep it aside so
  // an append goes before it rather than after
  const endsWithEol = lines.length > 0 && lines.at(-1) === '';
  if (endsWithEol) lines.pop();
  const out: string[] = [];
  let placed = false;
  for (const line of lines) {
    if (!isKeyLine(line, key)) {
      out.push(line);
      continue;
    }
    if (value !== null && !placed) out.push(`${key}=${value}`);
    placed = true;
  }
  const appended = value !== null && !placed;
  if (appended) out.push(`${key}=${value}`);
  if (out.length === 0) return '';
  // a file that ended in a newline keeps it; one we appended to gains one
  return out.join(eol) + (endsWithEol || appended ? eol : '');
}

export const DIRECTIONS = ['left', 'right', 'above', 'below'] as const;
export type Direction = (typeof DIRECTIONS)[number];

const centre = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** The displays (never the primary) whose centre lies in `dir` from the primary's. */
function inDirection(displays: DisplayInfo[], primary: DisplayInfo, dir: Direction): DisplayInfo[] {
  const p = centre(primary.workArea);
  return displays.filter((d) => {
    if (d.id === primary.id) return false;
    const c = centre(d.workArea);
    return dir === 'left' ? c.x < p.x : dir === 'right' ? c.x > p.x : dir === 'above' ? c.y < p.y : c.y > p.y;
  });
}

/** The nearest display whose centre lies in `dir` from the primary's. */
function nearestInDirection(
  displays: DisplayInfo[],
  primary: DisplayInfo,
  dir: Direction
): DisplayInfo | undefined {
  const p = centre(primary.workArea);
  let best: { d: DisplayInfo; dist: number } | undefined;
  for (const d of inDirection(displays, primary, dir)) {
    const c = centre(d.workArea);
    const dist = Math.hypot(c.x - p.x, c.y - p.y);
    if (!best || dist < best.dist) best = { d, dist };
  }
  return best?.d;
}

/**
 * What a saved value means against the displays attached right now.
 *
 * - `off`      — no value at all (unset, empty, blank): the default.
 * - `primary`  — a well-formed value that names the primary itself (`1`, or
 *                the primary's own `id:`). Behaves exactly like `off`.
 * - `display`  — a screen other than the primary: the tests move there.
 * - `missing`  — well-formed, but no attached screen answers to it (a direction
 *                with nothing that way, an index past the end, an id that is
 *                unplugged). The tests run on the primary until it is back.
 * - `invalid`  — not a value this resolver reads at all.
 */
export type TestDisplayResolution =
  | { kind: 'off' }
  | { kind: 'primary' }
  | { kind: 'display'; primary: DisplayInfo; target: DisplayInfo }
  | { kind: 'missing' }
  | { kind: 'invalid' };

export function resolveTestDisplay(
  displays: DisplayInfo[],
  primaryId: number,
  value: string | undefined | null
): TestDisplayResolution {
  const want = value?.trim().toLowerCase();
  if (!want) return { kind: 'off' };
  let target: DisplayInfo | undefined;
  let wellFormed = true;
  const primary = displays.find((d) => d.id === primaryId);
  if ((DIRECTIONS as readonly string[]).includes(want)) {
    target = primary && nearestInDirection(displays, primary, want as Direction);
  } else if (want.startsWith('id:')) {
    const rest = want.slice(3).trim();
    const id = Number(rest);
    if (!/^\d+$/.test(rest) || !Number.isSafeInteger(id)) wellFormed = false;
    else target = displays.find((d) => d.id === id);
  } else {
    const n = Number(want);
    if (!/^\d+$/.test(want) || !Number.isInteger(n) || n < 1) wellFormed = false;
    else if (primary) target = [primary, ...displays.filter((d) => d.id !== primaryId)][n - 1];
  }
  if (!wellFormed) return { kind: 'invalid' };
  // The offset is a delta FROM the primary, so with no primary there is
  // nothing to move by — not reachable through Electron, and not guessed at.
  if (!primary || !target) return { kind: 'missing' };
  if (target.id === primary.id) return { kind: 'primary' };
  return { kind: 'display', primary, target };
}

/**
 * The fixture's view: the screen to move to, or `null` for "do nothing".
 * Every non-`display` resolution is the same case to the caller.
 */
export function pickTestDisplay(
  displays: DisplayInfo[],
  primaryId: number,
  monitor: string | undefined
): { primary: DisplayInfo; target: DisplayInfo } | null {
  const r = resolveTestDisplay(displays, primaryId, monitor);
  return r.kind === 'display' ? { primary: r.primary, target: r.target } : null;
}

// ── What Settings shows and writes ──────────────────────────────────────────

/** One display as main reads it off `screen.getAllDisplays()`. */
export interface ScreenFacts extends DisplayInfo {
  bounds: Box;
  scaleFactor: number;
  /** the monitor's own name (Electron's `display.label`); may be empty */
  label: string;
}

/** Where a screen sits relative to the primary, in words a person uses. */
export type ScreenPosition =
  | 'primary'
  | 'left'
  | 'right'
  | 'above'
  | 'below'
  | 'above-left'
  | 'above-right'
  | 'below-left'
  | 'below-right'
  | 'overlapping';

/** One row of the picker. */
export interface TestScreen {
  id: number;
  /** "Screen N": the primary is 1, the rest left-to-right, then top-to-bottom */
  number: number;
  name: string;
  /** native pixels — what the OS's own display settings call the resolution */
  width: number;
  height: number;
  position: ScreenPosition;
  primary: boolean;
}

/**
 * Where `d` sits relative to `p`, by EDGES rather than centres: a screen is
 * "to the right" when it starts at or past the primary's right edge. Centres
 * would call a tall screen beside a short one "below" as well; edges say what
 * a person looking at the desk would say.
 */
export function screenPosition(d: Box, p: Box): ScreenPosition {
  const h = d.x >= p.x + p.width ? 'right' : d.x + d.width <= p.x ? 'left' : null;
  const v = d.y >= p.y + p.height ? 'below' : d.y + d.height <= p.y ? 'above' : null;
  if (h && v) return `${v}-${h}`;
  return h ?? v ?? 'overlapping';
}

/**
 * The picker's rows: the primary first (Screen 1), then the rest ordered by
 * where they sit — left to right, then top to bottom — so the numbers follow
 * the desk rather than whatever order Electron happened to list them in.
 *
 * The picker never WRITES these numbers (see `valueForScreen`); they are names
 * for a person to tell rows apart by.
 */
export function describeScreens(screens: ScreenFacts[], primaryId: number): TestScreen[] {
  const primary = screens.find((s) => s.id === primaryId);
  const rest = screens
    .filter((s) => s.id !== primaryId)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id);
  const ordered = primary ? [primary, ...rest] : rest;
  return ordered.map((s, i) => ({
    id: s.id,
    number: i + 1,
    name: s.label.trim(),
    width: Math.round(s.bounds.width * (s.scaleFactor || 1)),
    height: Math.round(s.bounds.height * (s.scaleFactor || 1)),
    position: primary && s.id !== primary.id ? screenPosition(s.bounds, primary.bounds) : 'primary',
    primary: s.id === primaryId,
  }));
}

/**
 * The value to save for "run the tests on this screen" — `null` for the
 * primary, meaning REMOVE the key (the default needs no line).
 *
 * A DIRECTION WORD when the screen is the only one that way from the primary,
 * because a word is readable in the file and means the same physical screen
 * after a DIFFERENT monitor detaches. When the word would be ambiguous (two
 * screens to the right) it is `id:<n>`, which no detach can re-point. Its own
 * detaching sends both forms to the primary, which is the fallback asked for.
 *
 * The axis the screen is further along is tried first, so a screen up and far
 * to the right is `right` rather than `above`. Each candidate is checked by
 * resolving it — the fixture's own reading — so this cannot write a word that
 * means some other screen.
 */
export function valueForScreen(displays: DisplayInfo[], primaryId: number, id: number): string | null {
  if (id === primaryId) return null;
  const primary = displays.find((d) => d.id === primaryId);
  const target = displays.find((d) => d.id === id);
  if (!primary || !target) return `id:${id}`;
  const p = centre(primary.workArea);
  const c = centre(target.workArea);
  const horizontal: Direction = c.x < p.x ? 'left' : 'right';
  const vertical: Direction = c.y < p.y ? 'above' : 'below';
  const order: Direction[] =
    Math.abs(c.x - p.x) >= Math.abs(c.y - p.y) ? [horizontal, vertical] : [vertical, horizontal];
  for (const dir of order) {
    const that = inDirection(displays, primary, dir);
    if (that.length === 1 && that[0].id === id) return dir;
  }
  return `id:${id}`;
}

// ── The IPC shapes (`testDisplay:get` / `:set` / `:changed`) ────────────────

/** What a saved value means, for the words under the control. */
export type SavedTestDisplay =
  /** no line in the file (or no file): the primary, the default */
  | { kind: 'none' }
  /** a value naming a screen that is attached: `screenId` is the one ticked */
  | { kind: 'attached'; value: string; screenId: number | null }
  /** well-formed, nothing attached answers to it: tests run on the primary */
  | { kind: 'missing'; value: string }
  /** not a value the tests can read (hand-written): tests run on the primary */
  | { kind: 'invalid'; value: string };

export interface TestDisplayState {
  /** every attached display, primary first */
  screens: TestScreen[];
  saved: SavedTestDisplay;
  /**
   * `SWITCHBOARD_E2E_NO_ACTIVATE` as the file says it (#1335): open the test
   * windows without taking focus. False for an absent file, an absent line, or
   * a file that could not be read.
   */
  noActivate: boolean;
  /** where the file lives, to say so on screen */
  file: string;
  /** the file exists but could not be read — shown, and writes are refused */
  readProblem?: string;
}

/**
 * Why a write was refused before any file was touched. Main decides these, so
 * they travel as codes and the renderer says them in the user's language; an
 * I/O failure has no code and carries the OS's own words in `problem`.
 */
export type TestDisplayRefusal = 'not-a-screen' | 'not-attached' | 'not-a-switch';

export type TestDisplaySetResult =
  | { ok: true; state: TestDisplayState }
  | { ok: false; problem: string; code?: TestDisplayRefusal; state: TestDisplayState };
